import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Res } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { pool, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { can, inScope } from '../auth/permissions.js';
import { loadModel } from '../metamodel/metamodel.js';
import { completeness } from '../records/validate.js';
import { VIEWPOINTS } from './catalog.js';
import { Level, missingBlocks, run } from './engine.js';
import { NotFoundException } from '@nestjs/common';

const ALERT_DAYS = 180;
const EOL_KEYS = ['support_end_date', 'expiry_date'];

@Controller('viewpoints')
export class ViewpointsController {
  /** The 35 phase-1 viewpoints, with whether each can be built for this entity right now. */
  @Perm('records.read')
  @Get('catalog')
  catalog(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => {
      const model = await loadModel(tx);
      const readable = (b: string) => { const d = model.blocks.find((x) => x.code === b); return !!d && inScope(u.roles, u.scope ?? {}, 'records.read', d.code, d.domain_code); };
      return VIEWPOINTS.map(({ spec, ...vp }) => ({ ...vp, kind: spec.kind, missing: missingBlocks({ spec, ...vp }, { model, readable }) }));
    });
  }

  /** Excel export of a viewpoint (FR-07-07): tables as they appear on screen, in the chosen language. */
  @Perm('reports.export')
  @Get('run/:code/xlsx')
  async exportOne(@CurrentUser() u: SessionUser, @Param('code') code: string, @Query('level') level: string, @Query('lang') lang: string, @Res() res: Response) {
    const vp = VIEWPOINTS.find((v) => v.code === code);
    if (!vp) throw new NotFoundException();
    const en = lang === 'en';
    const data = await this.runOne(u, code, level) as Record<string, any>;
    if (data.missing) throw new BadRequestException('لا توجد وحدات بناء متاحة');
    const model = await withActor(actorOf(u), loadModel);
    const bn = (c: string) => { const b = model.blocks.find((x) => x.code === c); return b ? (en ? b.name_en : b.name_ar) : c; };
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet((en ? vp.name_en : vp.name_ar).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), { views: [{ rightToLeft: !en }] });
    const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : Array.isArray(v) ? v.join('; ') : v);
    if (data.kind === 'list') {
      ws.addRow([en ? 'Name' : 'الاسم', ...data.columns.map((c: any) => (en ? c.name_en : c.name_ar))]);
      for (const r of data.rows) ws.addRow([safe(r.name), ...data.columns.map((c: any) => safe(r.attrs[c.key]))]);
    } else if (data.kind === 'matrix') {
      ws.addRow(['', ...data.cols.map((c: any) => safe(c.name))]);
      for (const r of data.rows) ws.addRow([safe(r.name), ...data.cols.map((c: any) => (data.cells.some((x: any) => x.row === r.id && x.col === c.id) ? '●' : ''))]);
    } else if (data.kind === 'group') {
      ws.addRow([en ? 'Group' : 'المجموعة', en ? 'Item' : 'العنصر', en ? 'Building block' : 'وحدة البناء']);
      for (const g of data.groups) for (const i of g.items) ws.addRow([safe(en ? g.label_en : g.label_ar), safe(i.name), bn(i.block_code)]);
    } else if (data.kind === 'nest') {
      ws.addRow([en ? 'Container' : 'الحاوية', en ? 'Item' : 'العنصر', en ? 'Building block' : 'وحدة البناء']);
      for (const c of data.containers) for (const i of c.children) ws.addRow([safe(c.name), safe(i.name), bn(i.block_code)]);
    } else {
      ws.addRow([en ? 'From' : 'من', en ? 'Relationship' : 'العلاقة', en ? 'To' : 'إلى']);
      const name = new Map(data.nodes.map((n: any) => [n.id, n.name]));
      for (const e of data.edges) ws.addRow([safe(name.get(e.source_id)), safe(en ? e.verb : e.name_ar ?? e.verb), safe(name.get(e.target_id))]);
    }
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 28));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${code}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  @Perm('records.read')
  @Get('run/:code')
  runOne(@CurrentUser() u: SessionUser, @Param('code') code: string, @Query('level') level: string) {
    const vp = VIEWPOINTS.find((v) => v.code === code);
    if (!vp) throw new NotFoundException();
    const lvl: Level = level === 'conceptual' || level === 'physical' ? level : 'logical';
    return withActor(actorOf(u), async (tx) => {
      const model = await loadModel(tx);
      const readable = (b: string) => { const d = model.blocks.find((x) => x.code === b); return !!d && inScope(u.roles, u.scope ?? {}, 'records.read', d.code, d.domain_code); };
      const missing = missingBlocks(vp, { model, readable });
      if (missing.length) return { code, missing };
      return { code, level: lvl, ...(await run(tx, vp.spec, { model, readable, level: lvl, showCost: can(u.roles, 'cost.read') })) };
    });
  }

  /** Relationship matrix between two building blocks (e.g. Applications × Servers). */
  @Perm('records.read')
  @Get('matrix')
  matrix(@CurrentUser() u: SessionUser, @Query('rows') rowsBlock: string, @Query('cols') colsBlock: string) {
    if (!rowsBlock || !colsBlock) throw new BadRequestException('rows & cols required');
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      for (const code of [rowsBlock, colsBlock]) {
        const b = m.blocks.find((x) => x.code === code);
        if (!b || !inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code)) throw new ForbiddenException();
      }
      const relations = m.relations.filter((r) => r.active &&
        ((r.source_code === rowsBlock && r.target_code === colsBlock) || (r.source_code === colsBlock && r.target_code === rowsBlock)));
      const rows = (await tx.query(`select id, name, status from records where block_code=$1 and status <> 'archived' order by name`, [rowsBlock])).rows;
      const cols = (await tx.query(`select id, name, status from records where block_code=$1 and status <> 'archived' order by name`, [colsBlock])).rows;
      const cells = (await tx.query(
        `select l.source_id, l.target_id, m.verb from record_links l join mm_relations m on m.id = l.relation_id where l.relation_id = any($1)`,
        [relations.map((r) => r.id)])).rows.map((c) => {
          const rowIsSource = rows.some((r) => r.id === c.source_id);
          return { row: rowIsSource ? c.source_id : c.target_id, col: rowIsSource ? c.target_id : c.source_id, verb: c.verb };
        });
      return { relations, rows, cols, cells };
    });
  }

  /** Node-link graph for a set of blocks (e.g. the application integration diagram). */
  @Perm('records.read')
  @Get('graph')
  graph(@CurrentUser() u: SessionUser, @Query('blocks') blocks: string) {
    const codes = (blocks ?? '').split(',').filter(Boolean);
    if (!codes.length) throw new BadRequestException('blocks required');
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const allowed = codes.filter((c) => {
        const b = m.blocks.find((x) => x.code === c);
        return b && inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code);
      });
      const nodes = (await tx.query(`select id, name, block_code, status from records where block_code = any($1) and status <> 'archived'`, [allowed])).rows;
      const edges = (await tx.query(
        `select l.id, l.source_id, l.target_id, m.verb from record_links l join mm_relations m on m.id = l.relation_id
          join records s on s.id = l.source_id join records t on t.id = l.target_id
         where s.block_code = any($1) and t.block_code = any($1) and s.status <> 'archived' and t.status <> 'archived'`, [allowed])).rows;
      return { nodes, edges };
    });
  }

  /** Entity dashboard: inventory, workflow, data quality and lifecycle alerts. */
  @Perm('records.read')
  @Get('dashboard')
  dashboard(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const recs = (await tx.query(`select id, name, block_code, status, attrs,
          exists (select 1 from record_links l where l.source_id = r.id or l.target_id = r.id) as linked
        from records r where status <> 'archived'`)).rows;
      const byBlock = new Map<string, { total: number; approved: number; pending: number; completeness: number; orphans: number }>();
      const alerts: { id: string; name: string; block: string; kind: string; date?: string }[] = [];
      const soon = new Date(Date.now() + ALERT_DAYS * 864e5).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      for (const r of recs) {
        const b = m.blocks.find((x) => x.code === r.block_code);
        if (!b || !inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code)) continue;
        const s = byBlock.get(b.code) ?? { total: 0, approved: 0, pending: 0, completeness: 0, orphans: 0 };
        s.total++;
        if (r.status === 'approved') s.approved++;
        if (r.status === 'submitted' || r.status === 'reviewed') s.pending++;
        s.completeness += completeness(b, r.attrs);
        if (!r.linked) s.orphans++;
        byBlock.set(b.code, s);
        for (const k of EOL_KEYS) {
          const d = r.attrs[k];
          if (typeof d === 'string' && d <= soon) alerts.push({ id: r.id, name: r.name, block: b.code, kind: d < today ? 'expired' : 'expiring', date: d });
        }
      }
      const blocks = m.blocks.filter((b) => b.active).map((b) => {
        const s = byBlock.get(b.code) ?? { total: 0, approved: 0, pending: 0, completeness: 0, orphans: 0 };
        return { code: b.code, name_ar: b.name_ar, domain: b.domain_code, ...s, completeness: s.total ? s.completeness / s.total : 0 };
      });
      alerts.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return { blocks, alerts: alerts.slice(0, 200), showCost: can(u.roles, 'cost.read') };
    });
  }

  /**
   * National (R8) and sector (R9) dashboards: aggregated counts only — never record-level data.
   * Entity users (R2/R6) get their own position against the average.
   */
  @Get('national')
  async national(@CurrentUser() u: SessionUser) {
    const national = u.roles.includes('R8');
    const sector = u.roles.includes('R9');
    const entity = !national && !sector && can(u.roles, 'dashboard.national');
    if (!national && !sector && !entity) throw new ForbiddenException();
    const { rows } = await pool.query('select * from aggregate_counts($1)', [sector && !national ? u.tenantId : null]);
    const tenants = new Map<string, { tenant: string; total: number; approved: number; domains: Record<string, number> }>();
    for (const r of rows) {
      const t = tenants.get(r.tenant_id) ?? { tenant: r.tenant_name, total: 0, approved: 0, domains: {} as Record<string, number> };
      t.total += Number(r.total); t.approved += Number(r.approved);
      t.domains[r.domain_code] = (t.domains[r.domain_code] ?? 0) + Number(r.total);
      tenants.set(r.tenant_id, t);
    }
    // Control coverage per entity (FR-13-02): share of leaf controls covered by at least one security asset.
    const comp = (await pool.query('select * from aggregate_compliance($1)', [sector && !national ? u.tenantId : null])).rows;
    const cov = new Map<string, { leaves: number; covered: number }>();
    for (const r of comp) {
      const c = cov.get(r.tenant_id) ?? { leaves: 0, covered: 0 };
      c.leaves += Number(r.leaves); c.covered += Number(r.covered);
      cov.set(r.tenant_id, c);
    }
    const list = [...tenants.entries()].map(([id, t]) => {
      const c = cov.get(id);
      return { id, ...t, approvedRatio: t.total ? t.approved / t.total : 0, coverage: c && c.leaves ? c.covered / c.leaves : null };
    });
    const avg = list.length ? list.reduce((s, t) => s + t.approvedRatio, 0) / list.length : 0;
    const withCov = list.filter((t) => t.coverage !== null);
    const avgCoverage = withCov.length ? withCov.reduce((s, t) => s + (t.coverage ?? 0), 0) / withCov.length : null;
    if (entity) {
      const mine = list.find((t) => t.id === u.tenantId);
      return { scope: 'entity', average: avg, averageCoverage: avgCoverage, entities: list.length, mine: mine ?? null };
    }
    return { scope: national ? 'national' : 'sector', average: avg, averageCoverage: avgCoverage, entities: list };
  }
}
