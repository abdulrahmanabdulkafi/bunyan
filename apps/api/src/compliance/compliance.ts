import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Res,
  UploadedFile, UseInterceptors, ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { classificationMark } from '../reports/reports.js';
import type { Response } from 'express';
import { z } from 'zod';
import { Tx, audit, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { inScope } from '../auth/permissions.js';
import { loadModel } from '../metamodel/metamodel.js';

/** Blocks that protect other assets; mapping one of them to a control is what "coverage" counts (BO-06). */
export const SECURITY_BLOCKS = ['security_hardware', 'security_software', 'security_service'];
/** Assets that should be protected by at least one security component (FR-10-03). */
export const PROTECTABLE = ['application', 'server', 'physical_host', 'network_device', 'storage', 'containerization_engine', 'data_center'];
const STATUSES = ['compliant', 'partial', 'non_compliant', 'not_applicable', 'not_assessed'] as const;

interface Item { id: string; framework_id: string; parent_id: string | null; code: string; level: string; title_ar: string; title_en: string | null; text_ar: string | null; text_en: string | null; sort: number }

/** Natural sort on codes like 1-10 vs 1-2. */
const codeKey = (c: string) => c.split('-').map((n) => n.padStart(4, '0')).join('-');

async function items(tx: Tx, frameworkId: string): Promise<Item[]> {
  const rows: Item[] = (await tx.query('select * from compliance_items where framework_id=$1', [frameworkId])).rows;
  return rows.sort((a, b) => codeKey(a.code).localeCompare(codeKey(b.code)));
}
/** Assessable items are the leaves: controls once loaded, otherwise the subdomains. */
function leaves(all: Item[]) {
  const parents = new Set(all.map((i) => i.parent_id).filter(Boolean));
  return all.filter((i) => !parents.has(i.id));
}

const FrameworkDto = z.object({
  code: z.string().min(2).max(20), version: z.string().min(1).max(20),
  name_ar: z.string().min(2), name_en: z.string().min(2), issuer_ar: z.string().optional(), issuer_en: z.string().optional(),
});
const AssessDto = z.object({
  record_id: z.string().uuid().nullable().default(null),
  status: z.enum(STATUSES).default('not_assessed'),
  evidence: z.string().max(5000).nullable().optional(),
  evidence_url: z.string().url().max(2000).nullable().optional().or(z.literal('')),
  assessed_at: z.string().date().nullable().optional().or(z.literal('')),
  remediation: z.string().max(5000).nullable().optional(),
  due_date: z.string().date().nullable().optional().or(z.literal('')),
});

@Controller('compliance')
export class ComplianceController {
  // ───────────── Library (platform admin) ─────────────
  @Get('frameworks')
  frameworks(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select f.*, (select count(*) from compliance_items i where i.framework_id = f.id) as item_count,
              (select count(*) from compliance_items i where i.framework_id = f.id and not exists (select 1 from compliance_items c where c.parent_id = i.id)) as leaf_count,
              coalesce((select enabled from tenant_frameworks t where t.framework_id = f.id and t.tenant_id = app_tenant()), false) as enabled
         from compliance_frameworks f order by f.code, f.version desc`)).rows);
  }

  @Perm('compliance.library')
  @Post('frameworks')
  createFramework(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const d = FrameworkDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      const row = (await tx.query(`insert into compliance_frameworks (code, version, name_ar, name_en, issuer_ar, issuer_en) values ($1,$2,$3,$4,$5,$6) returning *`,
        [d.code.toUpperCase(), d.version, d.name_ar, d.name_en, d.issuer_ar ?? null, d.issuer_en ?? null])).rows[0];
      await audit(tx, actorOf(u), 'create', 'compliance_framework', row.id, null, row);
      return row;
    });
  }

  @Perm('compliance.library')
  @Patch('frameworks/:id')
  patchFramework(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const p = FrameworkDto.partial().extend({ active: z.boolean().optional() }).parse(body);
    return withActor(actorOf(u), async (tx) => {
      const row = (await tx.query(`update compliance_frameworks set name_ar=coalesce($2,name_ar), name_en=coalesce($3,name_en), active=coalesce($4,active) where id=$1 returning *`,
        [id, p.name_ar ?? null, p.name_en ?? null, p.active ?? null])).rows[0];
      if (!row) throw new NotFoundException();
      await audit(tx, actorOf(u), 'update', 'compliance_framework', id, null, row);
      return row;
    });
  }

  /** Template for loading the approved control texts (FR-10-01). Existing items are included so the file doubles as an export. */
  @Perm('compliance.library')
  @Get('frameworks/:id/template')
  async template(@CurrentUser() u: SessionUser, @Param('id') id: string, @Res() res: Response) {
    const rows = await withActor(actorOf(u), (tx) => items(tx, id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('items', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'code', key: 'code', width: 12 }, { header: 'level', key: 'level', width: 12 }, { header: 'parent_code', key: 'parent', width: 12 },
      { header: 'title_ar', key: 'title_ar', width: 50 }, { header: 'title_en', key: 'title_en', width: 50 },
      { header: 'text_ar', key: 'text_ar', width: 80 }, { header: 'text_en', key: 'text_en', width: 80 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getCell('B1').note = 'domain | subdomain | control | subcontrol';
    for (const r of rows) ws.addRow({ ...r, parent: r.parent_id ? byId.get(r.parent_id)?.code : '' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="framework-items.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  /** Upsert items by code. Parents must appear in the file or already exist. All-or-nothing. */
  @Perm('compliance.library')
  @Post('frameworks/:id/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importItems(@CurrentUser() u: SessionUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('أرفق ملف Excel');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const head = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim());
    const col = (n: string) => head.indexOf(n);
    for (const n of ['code', 'level', 'title_ar']) if (col(n) < 0) throw new BadRequestException(`عمود مفقود: ${n}`);
    const str = (v: unknown) => { const s = v && typeof v === 'object' && 'text' in (v as object) ? (v as { text: string }).text : v; return s === null || s === undefined ? '' : String(s).trim(); };
    const rows: { code: string; level: string; parent: string; title_ar: string; title_en: string; text_ar: string; text_en: string; line: number }[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const get = (name: string) => (col(name) < 0 ? '' : str(row.getCell(col(name)).value));
      if (!get('code')) return;
      rows.push({ code: get('code'), level: get('level'), parent: get('parent_code'), title_ar: get('title_ar'), title_en: get('title_en'), text_ar: get('text_ar'), text_en: get('text_en'), line: n });
    });
    const errors: { row: number; message: string }[] = [];
    const levels = ['domain', 'subdomain', 'control', 'subcontrol'];
    return withActor(actorOf(u), async (tx) => {
      if (!(await tx.query('select 1 from compliance_frameworks where id=$1', [id])).rowCount) throw new NotFoundException();
      const existing = new Map((await items(tx, id)).map((i) => [i.code, i]));
      const codes = new Set([...existing.keys(), ...rows.map((r) => r.code)]);
      for (const r of rows) {
        if (!levels.includes(r.level)) errors.push({ row: r.line, message: `level: ${r.level}` });
        if (!r.title_ar) errors.push({ row: r.line, message: 'title_ar' });
        if (r.parent && !codes.has(r.parent)) errors.push({ row: r.line, message: `parent_code ${r.parent}` });
        if (r.level !== 'domain' && !r.parent) errors.push({ row: r.line, message: 'parent_code' });
      }
      if (errors.length) throw new BadRequestException({ message: 'أخطاء في الملف', errors: errors.map((e) => ({ key: String(e.row), message: e.message })) });
      // Parents first, so parent ids resolve.
      const order = [...rows].sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level));
      let created = 0, updated = 0;
      for (const [i, r] of order.entries()) {
        const parentId = r.parent ? (await tx.query('select id from compliance_items where framework_id=$1 and code=$2', [id, r.parent])).rows[0]?.id : null;
        const res = await tx.query(
          `insert into compliance_items (framework_id, parent_id, code, level, title_ar, title_en, text_ar, text_en, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (framework_id, code) do update set parent_id=excluded.parent_id, level=excluded.level, title_ar=excluded.title_ar,
             title_en=excluded.title_en, text_ar=excluded.text_ar, text_en=excluded.text_en returning (xmax = 0) as inserted`,
          [id, parentId, r.code, r.level, r.title_ar, r.title_en || null, r.text_ar || null, r.text_en || null, i]);
        if (res.rows[0].inserted) created++; else updated++;
      }
      await audit(tx, actorOf(u), 'import', 'compliance_framework', id, null, { created, updated });
      return { created, updated };
    });
  }

  // ───────────── Entity side ─────────────
  @Perm('compliance.assess')
  @Put('frameworks/:id/enabled')
  enable(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { enabled: boolean }) {
    if (!u.roles.includes('R2')) throw new ForbiddenException();
    return withActor(actorOf(u), async (tx) => {
      await tx.query(`insert into tenant_frameworks (tenant_id, framework_id, enabled) values (app_tenant(),$1,$2)
                      on conflict (tenant_id, framework_id) do update set enabled = excluded.enabled`, [id, !!body?.enabled]);
      await audit(tx, actorOf(u), body?.enabled ? 'enable' : 'disable', 'compliance_framework', id, null, null);
      return { ok: true };
    });
  }

  /** Framework tree with this entity's status per leaf (FR-10-04). */
  @Perm('compliance.read')
  @Get('frameworks/:id/tree')
  tree(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const all = await items(tx, id);
      const leafIds = new Set(leaves(all).map((l) => l.id));
      const own = (await tx.query(
        `select a.item_id, a.status, a.due_date from control_assessments a where a.record_id is null and a.item_id = any($1)`, [[...leafIds]])).rows;
      const maps = (await tx.query(
        `select a.item_id, count(*) as assets, count(*) filter (where r.block_code = any($2)) as security
           from control_assessments a join records r on r.id = a.record_id and r.status <> 'archived'
          where a.item_id = any($1) group by a.item_id`, [[...leafIds], SECURITY_BLOCKS])).rows;
      const st = new Map(own.map((o) => [o.item_id, o]));
      const mp = new Map(maps.map((m) => [m.item_id, m]));
      return all.map((i) => ({
        ...i, leaf: leafIds.has(i.id),
        status: leafIds.has(i.id) ? st.get(i.id)?.status ?? 'not_assessed' : null,
        due_date: st.get(i.id)?.due_date ?? null,
        assets: Number(mp.get(i.id)?.assets ?? 0), security_assets: Number(mp.get(i.id)?.security ?? 0),
      }));
    });
  }

  @Perm('compliance.read')
  @Get('items/:id')
  item(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const it = (await tx.query('select * from compliance_items where id=$1', [id])).rows[0];
      if (!it) throw new NotFoundException();
      const rows = (await tx.query(
        `select a.*, r.name as record_name, r.block_code, r.status as record_status, u.display_name as updated_by_name
           from control_assessments a left join records r on r.id = a.record_id left join users u on u.id = a.updated_by
          where a.item_id = $1 order by a.record_id nulls first, r.name`, [id])).rows;
      const path = [];
      let p = it.parent_id;
      while (p) { const x = (await tx.query('select id, code, title_ar, title_en, parent_id from compliance_items where id=$1', [p])).rows[0]; path.unshift(x); p = x?.parent_id; }
      return { item: it, path, entity: rows.find((r) => !r.record_id) ?? null, assets: rows.filter((r) => r.record_id) };
    });
  }

  /** Record (or update) an assessment. With record_id it also maps the asset to the control (FR-10-02). */
  @Perm('compliance.assess')
  @Put('items/:id/assessment')
  assess(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const d = AssessDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      if (d.record_id) {
        const rec = (await tx.query('select id, block_code from records where id=$1', [d.record_id])).rows[0];
        if (!rec) throw new NotFoundException();
        const m = await loadModel(tx);
        const b = m.blocks.find((x) => x.code === rec.block_code)!;
        if (!inScope(u.roles, u.scope ?? {}, 'compliance.assess', b.code, b.domain_code)) throw new ForbiddenException('خارج نطاق صلاحياتك');
      } else if (!u.roles.some((r) => r === 'R2' || r === 'R3')) {
        throw new ForbiddenException('خارج نطاق صلاحياتك'); // entity-level status: EA owner or architect
      }
      if (!(await tx.query('select 1 from compliance_items where id=$1', [id])).rowCount) throw new NotFoundException();
      const blank = (v: string | null | undefined) => (v === '' || v === undefined ? null : v);
      const before = (await tx.query(`select * from control_assessments where item_id=$1 and record_id is not distinct from $2`, [id, d.record_id])).rows[0] ?? null;
      const row = (await tx.query(
        `insert into control_assessments (tenant_id, item_id, record_id, status, evidence, evidence_url, assessed_at, remediation, due_date, updated_by)
         values (app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8,app_user())
         on conflict (item_id, tenant_id, coalesce(record_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set
           status=excluded.status, evidence=excluded.evidence, evidence_url=excluded.evidence_url, assessed_at=excluded.assessed_at,
           remediation=excluded.remediation, due_date=excluded.due_date, updated_by=excluded.updated_by, updated_at=now()
         returning *`,
        [id, d.record_id, d.status, blank(d.evidence), blank(d.evidence_url), blank(d.assessed_at), blank(d.remediation), blank(d.due_date)])).rows[0];
      await audit(tx, actorOf(u), 'assess', 'control_assessment', row.id, before, row);
      return row;
    });
  }

  @Perm('compliance.assess')
  @Delete('items/:id/assets/:recordId')
  unmap(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('recordId') recordId: string) {
    return withActor(actorOf(u), async (tx) => {
      const before = (await tx.query('delete from control_assessments where item_id=$1 and record_id=$2 returning *', [id, recordId])).rows[0];
      if (!before) throw new NotFoundException();
      await audit(tx, actorOf(u), 'unmap', 'control_assessment', before.id, before, null);
      return { ok: true };
    });
  }

  /** Controls mapped to one asset — shown on the record page. */
  @Perm('compliance.read')
  @Get('records/:id')
  forRecord(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select a.status, i.id as item_id, i.code, i.title_ar, i.title_en, f.code as framework, f.version
         from control_assessments a join compliance_items i on i.id = a.item_id join compliance_frameworks f on f.id = i.framework_id
        where a.record_id = $1 order by f.code, i.code`, [id])).rows);
  }

  /** Coverage and status per enabled framework and domain, plus unprotected assets (FR-10-03). */
  @Perm('compliance.read')
  @Get('summary')
  summary(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), (tx) => this.buildSummary(tx));
  }

  async buildSummary(tx: Tx) {
    const fws = (await tx.query(
      `select f.* from compliance_frameworks f join tenant_frameworks t on t.framework_id = f.id and t.enabled where f.active order by f.code`)).rows;
    const frameworks = [];
    for (const f of fws) {
      const all = await items(tx, f.id);
      const lv = leaves(all);
      const byId = new Map(all.map((i) => [i.id, i]));
      const domainOf = (i: Item): Item => { let x = i; while (x.parent_id && byId.get(x.parent_id)) x = byId.get(x.parent_id)!; return x; };
      const own = new Map((await tx.query(`select item_id, status from control_assessments where record_id is null and item_id = any($1)`, [lv.map((l) => l.id)])).rows.map((r) => [r.item_id, r.status]));
      const sec = new Set((await tx.query(
        `select distinct a.item_id from control_assessments a join records r on r.id = a.record_id and r.status <> 'archived'
          where a.item_id = any($1) and r.block_code = any($2)`, [lv.map((l) => l.id), SECURITY_BLOCKS])).rows.map((r) => r.item_id));
      const domains = new Map<string, { id: string; code: string; title_ar: string; title_en: string | null; total: number; covered: number; counts: Record<string, number> }>();
      const totals: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const l of lv) {
        const d = domainOf(l);
        const g = domains.get(d.id) ?? { id: d.id, code: d.code, title_ar: d.title_ar, title_en: d.title_en, total: 0, covered: 0, counts: Object.fromEntries(STATUSES.map((s) => [s, 0])) };
        const s = own.get(l.id) ?? 'not_assessed';
        g.total++; g.counts[s]++; totals[s]++;
        if (sec.has(l.id)) g.covered++;
        domains.set(d.id, g);
      }
      const applicable = lv.length - totals.not_applicable;
      frameworks.push({
        id: f.id, code: f.code, version: f.version, name_ar: f.name_ar, name_en: f.name_en,
        total: lv.length, covered: sec.size, counts: totals,
        // Compliance score: compliant = 1, partial = ½, over applicable controls.
        score: applicable ? (totals.compliant + totals.partial / 2) / applicable : 0,
        domains: [...domains.values()].sort((a, b) => codeKey(a.code).localeCompare(codeKey(b.code))),
      });
    }
    const unprotected = (await tx.query(
      `select r.id, r.name, r.block_code from records r
        where r.block_code = any($1) and r.status <> 'archived'
          and not exists (
            select 1 from record_links l join records s on s.id = case when l.source_id = r.id then l.target_id else l.source_id end
             where (l.source_id = r.id or l.target_id = r.id) and s.block_code = any($2) and s.status <> 'archived')
        order by r.block_code, r.name`, [PROTECTABLE, SECURITY_BLOCKS])).rows;
    return { frameworks, unprotected };
  }

  /** Exportable compliance report (FR-10-05): one sheet per framework with every control's status and evidence. */
  @Perm('reports.export')
  @Get('report.xlsx')
  async report(@CurrentUser() u: SessionUser, @Query('lang') lang: string, @Res() res: Response) {
    const en = lang === 'en';
    const L = (ar: string, e: string) => (en ? e : ar);
    const S: Record<string, [string, string]> = {
      compliant: ['ممتثل', 'Compliant'], partial: ['ممتثل جزئياً', 'Partially compliant'], non_compliant: ['غير ممتثل', 'Not compliant'],
      not_applicable: ['غير منطبق', 'Not applicable'], not_assessed: ['لم يُقيَّم', 'Not assessed'],
    };
    const wb = new ExcelJS.Workbook();
    await withActor(actorOf(u), async (tx) => {
      const sum = await this.buildSummary(tx);
      const ov = wb.addWorksheet(L('ملخص', 'Summary'), { views: [{ rightToLeft: !en }] });
      ov.addRow([L('الإطار', 'Framework'), L('الضوابط', 'Controls'), L('مغطاة بأصل أمني', 'Covered by a security asset'), L('ممتثل', 'Compliant'), L('جزئي', 'Partial'), L('غير ممتثل', 'Not compliant'), L('غير منطبق', 'N/A'), L('لم يُقيَّم', 'Not assessed'), L('درجة الامتثال', 'Compliance score')]);
      for (const f of sum.frameworks) ov.addRow([`${f.code}-${f.version}`, f.total, f.covered, f.counts.compliant, f.counts.partial, f.counts.non_compliant, f.counts.not_applicable, f.counts.not_assessed, Math.round(f.score * 100) / 100]);
      ov.addRow([]);
      ov.addRow([L('أصول بلا حماية أمنية مرتبطة', 'Assets with no linked security component'), sum.unprotected.length]);
      for (const x of sum.unprotected) ov.addRow(['', x.name, x.block_code]);
      ov.getRow(1).font = { bold: true };
      ov.columns.forEach((c) => (c.width = 22));
      for (const f of sum.frameworks) {
        const ws = wb.addWorksheet(`${f.code}-${f.version}`.replace(/[\\/?*[\]:]/g, '-').slice(0, 31), { views: [{ rightToLeft: !en, state: 'frozen', ySplit: 1 }] });
        ws.addRow([L('الرمز', 'Code'), L('الضابط', 'Control'), L('الحالة', 'Status'), L('الأصول المرتبطة', 'Mapped assets'), L('الأدلة', 'Evidence'), L('رابط الدليل', 'Evidence link'), L('تاريخ التقييم', 'Assessed on'), L('خطة المعالجة', 'Remediation'), L('تاريخ الاستحقاق', 'Due date')]);
        ws.getRow(1).font = { bold: true };
        const lv = leaves(await items(tx, f.id));
        const rows = (await tx.query(
          `select a.item_id, a.record_id, a.status, a.evidence, a.evidence_url, a.assessed_at, a.remediation, a.due_date, r.name
             from control_assessments a left join records r on r.id = a.record_id where a.item_id = any($1)`, [lv.map((l) => l.id)])).rows;
        for (const l of lv) {
          const own = rows.find((r) => r.item_id === l.id && !r.record_id);
          const assets = rows.filter((r) => r.item_id === l.id && r.record_id).map((r) => r.name).join('; ');
          const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v ?? '');
          ws.addRow([l.code, en ? l.title_en ?? l.title_ar : l.title_ar, S[own?.status ?? 'not_assessed'][en ? 1 : 0], safe(assets), safe(own?.evidence), safe(own?.evidence_url),
            own?.assessed_at ? String(own.assessed_at).slice(0, 10) : '', safe(own?.remediation), own?.due_date ? String(own.due_date).slice(0, 10) : '']);
        }
        ws.columns.forEach((c, i) => (c.width = i === 1 ? 60 : 20));
      }
      // NDMO marking on every sheet, printed or not.
      const cls = (await tx.query('select classification from tenants where id = app_tenant()')).rows[0]?.classification ?? 'restricted';
      const mark = classificationMark(cls, en);
      wb.subject = mark;
      for (const ws of wb.worksheets) { ws.headerFooter.oddHeader = `&C&B${mark}`; ws.headerFooter.oddFooter = `&L${mark}&R&P / &N`; }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-report.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }
}
