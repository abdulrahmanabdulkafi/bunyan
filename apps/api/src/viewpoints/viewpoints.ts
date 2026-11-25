import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Res } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { pool, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { can, inScope } from '../auth/permissions.js';
import { loadModel } from '../metamodel/metamodel.js';
import { completeness } from '../records/validate.js';
import { VIEWPOINTS, Viewpoint, ViewpointSpec, blocksOf } from './catalog.js';
import { planOf } from '../cycles/cycles.js';
import { Body, Delete, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Tx, audit } from '../common/db.js';
import type { Model } from '../metamodel/metamodel.js';
import { Level, PlanState, missingBlocks, run } from './engine.js';

const DOMAINS = ['strategy', 'business', 'beneficiary', 'data', 'applications', 'technology', 'security'] as const;
const codes = z.array(z.string().min(1)).min(1).max(20);
/** The same five declarative kinds as the national catalogue; an entity composes its own from them. */
export const SpecDto: z.ZodType<ViewpointSpec> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), blocks: codes.max(1), columns: z.array(z.string()).max(30).optional() }),
  z.object({ kind: z.literal('matrix'), rows: codes, cols: codes, via: z.array(z.string()).max(6).optional() }),
  z.object({ kind: z.literal('group'), blocks: codes, by: z.union([z.object({ attr: z.string().min(1) }), z.object({ related: z.string().min(1) }), z.object({ block: z.literal(true) })]) }),
  z.object({ kind: z.literal('nest'), container: z.string().min(1), children: codes }),
  z.object({ kind: z.literal('graph'), blocks: codes, collapse: z.string().optional() }),
]) as z.ZodType<ViewpointSpec>;
const CustomDto = z.object({
  name_ar: z.string().trim().min(2).max(200), name_en: z.string().trim().min(2).max(200),
  purpose_ar: z.string().max(500).nullable().optional(), purpose_en: z.string().max(500).nullable().optional(),
  domain: z.enum(DOMAINS), spec: SpecDto,
});

function checkSpec(spec: ViewpointSpec, model: Model) {
  const unknown = blocksOf(spec).filter((b) => !model.blocks.some((x) => x.code === b));
  if (spec.kind === 'graph' && spec.collapse && !spec.blocks.includes(spec.collapse)) unknown.push(spec.collapse);
  if (unknown.length) throw new BadRequestException(`وحدات بناء غير معروفة: ${unknown.join('، ')}`);
  if (spec.kind === 'group' && 'attr' in spec.by) {
    const attr = spec.by.attr;
    if (!spec.blocks.every((b) => model.blocks.find((x) => x.code === b)!.attributes.some((a) => a.key === attr))) throw new BadRequestException('سمة التجميع غير موجودة في كل الوحدات المختارة');
  }
}

/** A national viewpoint, or one of this entity's own. */
async function findVp(tx: Tx, code: string): Promise<(Viewpoint & { custom?: boolean }) | undefined> {
  const n = VIEWPOINTS.find((v) => v.code === code);
  if (n) return n;
  const c = (await tx.query('select * from custom_viewpoints where code=$1', [code])).rows[0];
  return c && { code: c.code, domain: c.domain, name_ar: c.name_ar, name_en: c.name_en, purpose_ar: c.purpose_ar ?? '', purpose_en: c.purpose_en ?? '', spec: c.spec, custom: true };
}

/** `?cycle=<id>&state=current|target` — show the architecture before or after a development cycle's planned changes. */
async function planFor(tx: Tx, cycle?: string, state?: string): Promise<PlanState | undefined> {
  if (!cycle || (state !== 'current' && state !== 'target')) return undefined;
  if (!(await tx.query('select 1 from ea_cycles where id=$1', [cycle])).rowCount) throw new NotFoundException();
  return { mode: state, ...(await planOf(tx, cycle)) };
}
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
      const custom = (await tx.query('select * from custom_viewpoints order by code')).rows
        .map((c) => ({ code: c.code, domain: c.domain, name_ar: c.name_ar, name_en: c.name_en, purpose_ar: c.purpose_ar ?? '', purpose_en: c.purpose_en ?? '', spec: c.spec as ViewpointSpec, custom: true }));
      return [...VIEWPOINTS, ...custom].map(({ spec, ...vp }) => ({ ...vp, kind: spec.kind, missing: missingBlocks({ spec, ...vp } as Viewpoint, { model, readable }) }));
    });
  }

  /** Excel export of a viewpoint (FR-07-07): tables as they appear on screen, in the chosen language. */
  @Perm('reports.export')
  @Get('run/:code/xlsx')
  async exportOne(@CurrentUser() u: SessionUser, @Param('code') code: string, @Query('level') level: string, @Query('lang') lang: string, @Res() res: Response,
    @Query('cycle') cycle?: string, @Query('state') state?: string) {
    const vp = await withActor(actorOf(u), (tx) => findVp(tx, code));
    if (!vp) throw new NotFoundException();
    const en = lang === 'en';
    const data = await this.runOne(u, code, level, cycle, state) as Record<string, any>;
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
  runOne(@CurrentUser() u: SessionUser, @Param('code') code: string, @Query('level') level: string, @Query('cycle') cycle?: string, @Query('state') state?: string) {
    const lvl: Level = level === 'conceptual' || level === 'physical' ? level : 'logical';
    return withActor(actorOf(u), async (tx) => {
      const vp = await findVp(tx, code);
      if (!vp) throw new NotFoundException();
      const plan = await planFor(tx, cycle, state);
      const model = await loadModel(tx);
      const readable = (b: string) => { const d = model.blocks.find((x) => x.code === b); return !!d && inScope(u.roles, u.scope ?? {}, 'records.read', d.code, d.domain_code); };
      const missing = missingBlocks(vp, { model, readable });
      if (missing.length) return { code, missing };
      return { code, level: lvl, ...(plan ? { state: plan.mode } : {}), ...(await run(tx, vp.spec, { model, readable, level: lvl, showCost: can(u.roles, 'cost.read'), plan })) };
    });
  }

  /** Relationship matrix between two building blocks (e.g. Applications × Servers). */
  /** Build a viewpoint from a spec without saving it: the live preview of the viewpoint builder. */
  @Perm('viewpoints.build')
  @Post('preview')
  preview(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const spec = SpecDto.parse((body as { spec?: unknown })?.spec);
    return withActor(actorOf(u), async (tx) => {
      const model = await loadModel(tx);
      checkSpec(spec, model);
      const readable = (b: string) => { const d = model.blocks.find((x) => x.code === b); return !!d && inScope(u.roles, u.scope ?? {}, 'records.read', d.code, d.domain_code); };
      const missing = missingBlocks({ spec } as Viewpoint, { model, readable });
      if (missing.length) return { missing };
      return run(tx, spec, { model, readable, level: 'logical', showCost: can(u.roles, 'cost.read') });
    });
  }

  @Perm('viewpoints.build')
  @Post('custom')
  createCustom(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const d = CustomDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      checkSpec(d.spec, await loadModel(tx));
      const n = Number((await tx.query(`select coalesce(max(substring(code from 5)::int), 0) + 1 as n from custom_viewpoints where code ~ '^CUS-[0-9]+$'`)).rows[0].n);
      const row = (await tx.query(
        `insert into custom_viewpoints (tenant_id, code, domain, name_ar, name_en, purpose_ar, purpose_en, spec, created_by)
         values (app_tenant(), $1, $2, $3, $4, $5, $6, $7, app_user()) returning *`,
        [`CUS-${n}`, d.domain, d.name_ar, d.name_en, d.purpose_ar ?? null, d.purpose_en ?? null, JSON.stringify(d.spec)])).rows[0];
      await audit(tx, actorOf(u), 'create', 'custom_viewpoint', row.id, null, row);
      return row;
    });
  }

  @Perm('viewpoints.build')
  @Get('custom/:code')
  getCustom(@CurrentUser() u: SessionUser, @Param('code') code: string) {
    return withActor(actorOf(u), async (tx) => {
      const row = (await tx.query('select * from custom_viewpoints where code=$1', [code])).rows[0];
      if (!row) throw new NotFoundException();
      return row;
    });
  }

  @Perm('viewpoints.build')
  @Patch('custom/:code')
  updateCustom(@CurrentUser() u: SessionUser, @Param('code') code: string, @Body() body: unknown) {
    const d = CustomDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      checkSpec(d.spec, await loadModel(tx));
      const cur = (await tx.query('select * from custom_viewpoints where code=$1', [code])).rows[0];
      if (!cur) throw new NotFoundException();
      const row = (await tx.query(
        `update custom_viewpoints set domain=$2, name_ar=$3, name_en=$4, purpose_ar=$5, purpose_en=$6, spec=$7, updated_at=now() where code=$1 returning *`,
        [code, d.domain, d.name_ar, d.name_en, d.purpose_ar ?? null, d.purpose_en ?? null, JSON.stringify(d.spec)])).rows[0];
      await audit(tx, actorOf(u), 'update', 'custom_viewpoint', row.id, cur, row);
      return row;
    });
  }

  @Perm('viewpoints.build')
  @Delete('custom/:code')
  removeCustom(@CurrentUser() u: SessionUser, @Param('code') code: string) {
    return withActor(actorOf(u), async (tx) => {
      const cur = (await tx.query('delete from custom_viewpoints where code=$1 returning *', [code])).rows[0];
      if (!cur) throw new NotFoundException();
      await audit(tx, actorOf(u), 'delete', 'custom_viewpoint', cur.id, cur, null);
      return { ok: true };
    });
  }

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
