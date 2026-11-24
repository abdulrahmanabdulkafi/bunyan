import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { Tx, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { COST_KEYS, can, inScope } from '../auth/permissions.js';
import { BlockDef, loadModel } from '../metamodel/metamodel.js';

/**
 * Reports centre (FR-11): the repository's own health and the figures EA offices are asked for —
 * inventory, data quality, lifecycle and end-of-support, relationship coverage, cost and the approval queue.
 * Every report covers only the blocks the user may read, and every Excel file carries the entity's NDMO
 * classification in its header, footer and cover sheet.
 */

export const REPORTS = ['inventory', 'quality', 'lifecycle', 'relations', 'cost', 'workflow'] as const;
type Code = (typeof REPORTS)[number];

const STALE_DAYS = 180;
/** Date attributes that mark the end of something: support, licence, contract. */
const END_KEYS = /(support_end|end_of|expiry|expiration|end_date|retire)/;

const CLS: Record<string, [string, string]> = {
  top_secret: ['سري للغاية', 'Top secret'], secret: ['سري', 'Secret'], restricted: ['مقيد', 'Restricted'], public: ['عام', 'Public'],
};
const STATUS: Record<string, [string, string]> = {
  draft: ['مسودة', 'Draft'], submitted: ['بانتظار المراجعة', 'Awaiting review'], reviewed: ['معتمد مبدئياً', 'Reviewed'],
  approved: ['معتمد', 'Approved'], rejected: ['مرفوض', 'Rejected'], archived: ['مؤرشف', 'Archived'],
};

export function classificationMark(cls: string, en: boolean) {
  return `${en ? 'Classification' : 'التصنيف'}: ${(CLS[cls] ?? CLS.restricted)[en ? 1 : 0]}`;
}

interface Ctx { tx: Tx; u: SessionUser; blocks: BlockDef[]; model: Awaited<ReturnType<typeof loadModel>> }
const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const r2 = (x: number) => Math.round(x * 1000) / 1000;

@Controller('reports')
export class ReportsController {
  @Perm('records.read')
  @Get()
  list() {
    return REPORTS;
  }

  @Perm('records.read')
  @Get(':code')
  async json(@CurrentUser() u: SessionUser, @Param('code') code: string) {
    return withActor(actorOf(u), async (tx) => this.build(await this.ctx(tx, u), this.code(code)));
  }

  @Perm('reports.export')
  @Get(':code/xlsx')
  async xlsx(@CurrentUser() u: SessionUser, @Param('code') code: string, @Query('lang') lang: string, @Res() res: Response) {
    const c = this.code(code);
    const en = lang === 'en';
    const wb = new ExcelJS.Workbook();
    await withActor(actorOf(u), async (tx) => {
      const ctx = await this.ctx(tx, u);
      const data = await this.build(ctx, c);
      const t = (await tx.query('select name_ar, name_en, classification from tenants where id = app_tenant()')).rows[0];
      writeWorkbook(wb, c, data, { en, ctx, tenant: t, user: u });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bunyan-${c}-report.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  private code(c: string): Code {
    if (!(REPORTS as readonly string[]).includes(c)) throw new BadRequestException('تقرير غير معروف');
    return c as Code;
  }

  private async ctx(tx: Tx, u: SessionUser): Promise<Ctx> {
    if (!u.tenantId) throw new ForbiddenException('التقارير على مستوى الجهة');
    const model = await loadModel(tx);
    const blocks = model.blocks.filter((b) => b.active && inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code));
    return { tx, u, blocks, model };
  }

  async build(ctx: Ctx, code: Code) {
    switch (code) {
      case 'inventory': return inventory(ctx);
      case 'quality': return quality(ctx);
      case 'lifecycle': return lifecycle(ctx);
      case 'relations': return relations(ctx);
      case 'cost': return cost(ctx);
      case 'workflow': return workflow(ctx);
    }
  }
}

async function records(ctx: Ctx, extra = '') {
  return (await ctx.tx.query(
    `select id, block_code, name, attrs, status, updated_at, created_at from records
      where block_code = any($1) and status <> 'archived' ${extra} order by block_code, name`, [ctx.blocks.map((b) => b.code)])).rows as
    { id: string; block_code: string; name: string; attrs: Record<string, unknown>; status: string; updated_at: Date; created_at: Date }[];
}
async function linkedIds(ctx: Ctx) {
  const rows = (await ctx.tx.query(`select source_id, target_id from record_links`)).rows as { source_id: string; target_id: string }[];
  const s = new Set<string>();
  for (const r of rows) { s.add(r.source_id); s.add(r.target_id); }
  return s;
}
const domainOf = (ctx: Ctx, b: BlockDef) => ctx.model.domains.find((d) => d.code === b.domain_code);

async function inventory(ctx: Ctx) {
  const recs = await records(ctx);
  const rows = ctx.blocks.map((b) => {
    const mine = recs.filter((r) => r.block_code === b.code);
    const by: Record<string, number> = {};
    for (const r of mine) by[r.status] = (by[r.status] ?? 0) + 1;
    const comp = mine.map((r) => completenessOf(b, r.attrs));
    return {
      domain: b.domain_code, domain_ar: domainOf(ctx, b)?.name_ar, domain_en: domainOf(ctx, b)?.name_en,
      block: b.code, name_ar: b.name_ar, name_en: b.name_en, total: mine.length, by_status: by,
      approved_ratio: mine.length ? r2((by.approved ?? 0) / mine.length) : 0,
      completeness: comp.length ? r2(comp.reduce((a, x) => a + x, 0) / comp.length) : 0,
    };
  });
  const total = recs.length;
  const approved = recs.filter((r) => r.status === 'approved').length;
  return { total, approved, blocks_used: rows.filter((r) => r.total).length, blocks_active: rows.length, rows };
}

function completenessOf(b: BlockDef, attrs: Record<string, unknown>) {
  const act = b.attributes.filter((a) => a.active);
  return act.length ? act.filter((a) => filled(attrs[a.key])).length / act.length : 1;
}

async function quality(ctx: Ctx) {
  const recs = await records(ctx);
  const linked = await linkedIds(ctx);
  const staleBefore = Date.now() - STALE_DAYS * 864e5;
  const issues: { record_id: string; block: string; name: string; issue: string; detail?: string }[] = [];
  const blocks = ctx.blocks.map((b) => {
    const mine = recs.filter((r) => r.block_code === b.code);
    const req = b.attributes.filter((a) => a.active && a.required);
    const seen = new Map<string, number>();
    let missingReq = 0, low = 0, orphan = 0, stale = 0, dup = 0, comp = 0;
    for (const r of mine) {
      const c = completenessOf(b, r.attrs); comp += c;
      const miss = req.filter((a) => !filled(r.attrs[a.key]));
      if (miss.length) { missingReq++; issues.push({ record_id: r.id, block: b.code, name: r.name, issue: 'missing_required', detail: miss.map((a) => a.key).join(',') }); }
      if (c < 0.5) { low++; issues.push({ record_id: r.id, block: b.code, name: r.name, issue: 'low_completeness', detail: String(Math.round(c * 100)) }); }
      if (!linked.has(r.id)) { orphan++; issues.push({ record_id: r.id, block: b.code, name: r.name, issue: 'no_relations' }); }
      if (new Date(r.updated_at).getTime() < staleBefore) { stale++; issues.push({ record_id: r.id, block: b.code, name: r.name, issue: 'stale', detail: String(r.updated_at).slice(0, 10) }); }
      const k = (r.name ?? '').trim().toLowerCase();
      if (k) {
        if (seen.has(k)) { dup++; issues.push({ record_id: r.id, block: b.code, name: r.name, issue: 'duplicate_name' }); }
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
    const fill = b.attributes.filter((a) => a.active).map((a) => ({
      key: a.key, name_ar: a.name_ar, name_en: a.name_en, required: a.required,
      ratio: mine.length ? r2(mine.filter((r) => filled(r.attrs[a.key])).length / mine.length) : 0,
    }));
    return {
      block: b.code, name_ar: b.name_ar, name_en: b.name_en, total: mine.length,
      completeness: mine.length ? r2(comp / mine.length) : 0,
      missing_required: missingReq, low_completeness: low, no_relations: orphan, stale, duplicate_names: dup, fill,
    };
  }).filter((x) => x.total);
  const total = recs.length;
  // One score the EA office can track over time: the mean of completeness, relation coverage and required-field coverage.
  const sum = (f: (b: (typeof blocks)[number]) => number) => blocks.reduce((a, b) => a + f(b), 0);
  const score = total ? r2((sum((b) => b.completeness * b.total) / total + (1 - sum((b) => b.no_relations) / total) + (1 - sum((b) => b.missing_required) / total)) / 3) : 0;
  return { total, score, stale_days: STALE_DAYS, blocks, issues: issues.slice(0, 5000), issues_total: issues.length };
}

async function lifecycle(ctx: Ctx) {
  const recs = await records(ctx);
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const items: { record_id: string; block: string; name: string; key: string; date: string; days: number; bucket: string; status: string }[] = [];
  for (const b of ctx.blocks) {
    const keys = b.attributes.filter((a) => a.active && a.type === 'date' && END_KEYS.test(a.key)).map((a) => a.key);
    if (!keys.length) continue;
    for (const r of recs.filter((x) => x.block_code === b.code)) {
      for (const k of keys) {
        const v = r.attrs[k];
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
        const days = Math.round((new Date(v.slice(0, 10)).getTime() - today) / 864e5);
        const bucket = days < 0 ? 'expired' : days <= 90 ? 'd90' : days <= 180 ? 'd180' : days <= 365 ? 'd365' : 'later';
        items.push({ record_id: r.id, block: b.code, name: r.name, key: k, date: v.slice(0, 10), days, bucket, status: r.status });
      }
    }
  }
  items.sort((a, b) => a.days - b.days);
  const counts: Record<string, number> = { expired: 0, d90: 0, d180: 0, d365: 0, later: 0 };
  for (const i of items) counts[i.bucket]++;
  const tracked = ctx.blocks.filter((b) => b.attributes.some((a) => a.active && a.type === 'date' && END_KEYS.test(a.key)))
    .map((b) => {
      const n = recs.filter((r) => r.block_code === b.code).length;
      const withDate = new Set(items.filter((i) => i.block === b.code).map((i) => i.record_id)).size;
      return { block: b.code, name_ar: b.name_ar, name_en: b.name_en, total: n, with_date: withDate };
    }).filter((x) => x.total);
  return { counts, items, tracked };
}

async function relations(ctx: Ctx) {
  const codes = new Set(ctx.blocks.map((b) => b.code));
  const recs = await records(ctx);
  const per = (await ctx.tx.query(
    `select relation_id, count(*)::int n, count(distinct source_id)::int sources, count(distinct target_id)::int targets from record_links group by relation_id`)).rows as
    { relation_id: string; n: number; sources: number; targets: number }[];
  const countOf = (code: string) => recs.filter((r) => r.block_code === code).length;
  const rels = ctx.model.relations.filter((r) => r.active && codes.has(r.source_code) && codes.has(r.target_code)).map((r) => {
    const p = per.find((x) => x.relation_id === r.id);
    const src = countOf(r.source_code);
    return {
      id: r.id, source: r.source_code, verb: r.verb, name_ar: r.name_ar, target: r.target_code,
      links: p?.n ?? 0, source_coverage: src ? r2((p?.sources ?? 0) / src) : 0, source_total: src,
    };
  }).filter((r) => r.source_total);
  const linked = await linkedIds(ctx);
  const orphans = recs.filter((r) => !linked.has(r.id)).map((r) => ({ record_id: r.id, block: r.block_code, name: r.name, status: r.status }));
  const blocks = ctx.blocks.map((b) => {
    const mine = recs.filter((r) => r.block_code === b.code);
    return { block: b.code, name_ar: b.name_ar, name_en: b.name_en, total: mine.length, linked: mine.filter((r) => linked.has(r.id)).length };
  }).filter((b) => b.total);
  return { links: per.reduce((a, x) => a + x.n, 0), relations: rels, blocks, orphans };
}

async function cost(ctx: Ctx) {
  if (!can(ctx.u.roles, 'cost.read')) throw new ForbiddenException('لا تملك صلاحية الاطلاع على التكاليف');
  const recs = await records(ctx);
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : 0);
  const blocks = ctx.blocks.map((b) => {
    const keys = b.attributes.filter((a) => a.active && a.type === 'number' && COST_KEYS.test(a.key));
    if (!keys.length) return null;
    const mine = recs.filter((r) => r.block_code === b.code);
    const capital = mine.reduce((a, r) => a + num(r.attrs.capital_cost), 0);
    const operating = mine.reduce((a, r) => a + num(r.attrs.operating_cost), 0);
    const top = mine.map((r) => ({ record_id: r.id, name: r.name, capital: num(r.attrs.capital_cost), operating: num(r.attrs.operating_cost) }))
      .filter((x) => x.capital || x.operating).sort((a, b) => b.capital + b.operating - (a.capital + a.operating)).slice(0, 10);
    const missing = mine.filter((r) => keys.every((k) => !filled(r.attrs[k.key]))).length;
    return { block: b.code, name_ar: b.name_ar, name_en: b.name_en, total: mine.length, capital, operating, missing, top };
  }).filter((x): x is NonNullable<typeof x> => !!x && x.total > 0);
  return {
    capital: blocks.reduce((a, b) => a + b.capital, 0), operating: blocks.reduce((a, b) => a + b.operating, 0), blocks,
  };
}

async function workflow(ctx: Ctx) {
  const recs = await records(ctx, `and status in ('draft','submitted','reviewed','rejected')`);
  const now = Date.now();
  const items = recs.map((r) => ({
    record_id: r.id, block: r.block_code, name: r.name, status: r.status, days: Math.floor((now - new Date(r.updated_at).getTime()) / 864e5),
  })).sort((a, b) => b.days - a.days);
  const counts: Record<string, number> = { draft: 0, submitted: 0, reviewed: 0, rejected: 0 };
  for (const i of items) counts[i.status]++;
  const waiting = items.filter((i) => i.status === 'submitted' || i.status === 'reviewed');
  return {
    counts, items: items.slice(0, 5000),
    oldest_waiting_days: waiting.length ? waiting[0].days : 0,
    median_waiting_days: waiting.length ? waiting.map((i) => i.days).sort((a, b) => a - b)[Math.floor(waiting.length / 2)] : 0,
  };
}

// ───────────────────────────── Excel ─────────────────────────────

const TITLES: Record<Code, [string, string]> = {
  inventory: ['تقرير حصر المستودع', 'Repository inventory'],
  quality: ['تقرير جودة البيانات', 'Data quality'],
  lifecycle: ['تقرير دورة الحياة وانتهاء الدعم', 'Lifecycle and end of support'],
  relations: ['تقرير تغطية العلاقات', 'Relationship coverage'],
  cost: ['تقرير التكاليف', 'Cost'],
  workflow: ['تقرير طابور الاعتماد', 'Approval queue'],
};
const ISSUE: Record<string, [string, string]> = {
  missing_required: ['سمات إلزامية ناقصة', 'Missing required attributes'], low_completeness: ['اكتمال أقل من 50٪', 'Completeness below 50%'],
  no_relations: ['بلا علاقات', 'No relationships'], stale: [`لم يُحدَّث منذ ${STALE_DAYS} يوماً`, `Not updated in ${STALE_DAYS} days`],
  duplicate_name: ['اسم مكرر', 'Duplicate name'],
};
const BUCKET: Record<string, [string, string]> = {
  expired: ['منتهٍ', 'Expired'], d90: ['خلال 90 يوماً', 'Within 90 days'], d180: ['خلال 180 يوماً', 'Within 180 days'],
  d365: ['خلال سنة', 'Within a year'], later: ['بعد سنة', 'Later'],
};

interface WOpts { en: boolean; ctx: Ctx; tenant: { name_ar: string; name_en: string | null; classification: string }; user: SessionUser }

function writeWorkbook(wb: ExcelJS.Workbook, code: Code, data: Record<string, unknown>, o: WOpts) {
  const { en, ctx } = o;
  const L = (p: [string, string]) => (en ? p[1] : p[0]);
  const bn = (c: string) => { const b = ctx.model.blocks.find((x) => x.code === c); return b ? (en ? b.name_en : b.name_ar) : c; };
  const an = (block: string, key: string) => {
    const a = ctx.model.blocks.find((x) => x.code === block)?.attributes.find((x) => x.key === key);
    return a ? (en ? a.name_en : a.name_ar) : key;
  };
  const cls = L(CLS[o.tenant.classification] ?? CLS.restricted);
  const mark = `${en ? 'Classification' : 'التصنيف'}: ${cls}`;
  wb.creator = 'Bunyan';
  wb.title = L(TITLES[code]);
  wb.subject = mark;
  wb.keywords = mark;
  wb.created = new Date();

  const sheet = (name: string, headers: string[], widths: number[] = []) => {
    const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, '-').slice(0, 31), { views: [{ rightToLeft: !en, state: 'frozen', ySplit: 1 }] });
    ws.headerFooter.oddHeader = `&C&B${mark}`;
    ws.headerFooter.oddFooter = `&L${mark}&R&P / &N`;
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5C4A' } };
    ws.columns = headers.map((_, i) => ({ width: widths[i] ?? 18 }));
    return ws;
  };
  const pct = (x: number) => x; // stored as a fraction, formatted below
  const fmtPct = (ws: ExcelJS.Worksheet, cols: number[]) => cols.forEach((c) => (ws.getColumn(c).numFmt = '0%'));
  const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v ?? '');

  // Cover: what this is, for whom, when, and how it is classified.
  const cover = wb.addWorksheet(en ? 'About' : 'عن التقرير', { views: [{ rightToLeft: !en }] });
  cover.headerFooter.oddHeader = `&C&B${mark}`;
  cover.columns = [{ width: 28 }, { width: 60 }];
  const t = cover.addRow([L(TITLES[code])]); t.font = { bold: true, size: 16 };
  cover.addRow([]);
  cover.addRow([en ? 'Entity' : 'الجهة', en ? o.tenant.name_en ?? o.tenant.name_ar : o.tenant.name_ar]);
  const c = cover.addRow([en ? 'Data classification (NDMO)' : 'تصنيف البيانات (مكتب إدارة البيانات الوطنية)', cls]);
  c.getCell(2).font = { bold: true, color: { argb: 'FF8A5A00' } };
  cover.addRow([en ? 'Generated on' : 'تاريخ الإصدار', new Date().toISOString().slice(0, 16).replace('T', ' ')]);
  cover.addRow([en ? 'Generated by' : 'أصدره', o.user.email]);
  cover.addRow([en ? 'Coverage' : 'النطاق', en ? `${ctx.blocks.length} building blocks within your permissions` : `${ctx.blocks.length} وحدة بناء ضمن صلاحياتك`]);
  cover.addRow([]);
  cover.addRow([en ? 'Handle according to the classification above; do not share outside authorised parties.' : 'يُتداول وفق التصنيف أعلاه، ولا يُشارك خارج الجهات المصرّح لها.']);

  const d = data as never as Record<string, never>;
  if (code === 'inventory') {
    const ws = sheet(en ? 'Inventory' : 'الحصر', [en ? 'Domain' : 'المجال', en ? 'Building block' : 'وحدة البناء', en ? 'Records' : 'السجلات',
      ...Object.keys(STATUS).filter((s) => s !== 'archived').map((s) => L(STATUS[s])), en ? 'Approved share' : 'نسبة المعتمد', en ? 'Average completeness' : 'متوسط الاكتمال'], [22, 30]);
    for (const r of d.rows as { domain_ar: string; domain_en: string; name_ar: string; name_en: string; total: number; by_status: Record<string, number>; approved_ratio: number; completeness: number }[]) {
      ws.addRow([en ? r.domain_en : r.domain_ar, en ? r.name_en : r.name_ar, r.total, ...Object.keys(STATUS).filter((s) => s !== 'archived').map((s) => r.by_status[s] ?? 0), pct(r.approved_ratio), pct(r.completeness)]);
    }
    fmtPct(ws, [9, 10]);
  }
  if (code === 'quality') {
    const ws = sheet(en ? 'By block' : 'حسب الوحدة', [en ? 'Building block' : 'وحدة البناء', en ? 'Records' : 'السجلات', en ? 'Average completeness' : 'متوسط الاكتمال',
      L(ISSUE.missing_required), L(ISSUE.low_completeness), L(ISSUE.no_relations), L(ISSUE.stale), L(ISSUE.duplicate_name)], [30]);
    type QB = { block: string; total: number; completeness: number; missing_required: number; low_completeness: number; no_relations: number; stale: number; duplicate_names: number; fill: { key: string; required: boolean; ratio: number }[] };
    for (const b of d.blocks as QB[]) ws.addRow([bn(b.block), b.total, b.completeness, b.missing_required, b.low_completeness, b.no_relations, b.stale, b.duplicate_names]);
    fmtPct(ws, [3]);
    ws.addRow([]);
    ws.addRow([en ? 'Data quality score' : 'مؤشر جودة البيانات', '', d.score]).font = { bold: true };
    ws.getCell(ws.rowCount, 3).numFmt = '0%';
    const f = sheet(en ? 'Attribute fill rate' : 'اكتمال السمات', [en ? 'Building block' : 'وحدة البناء', en ? 'Attribute' : 'السمة', en ? 'Required' : 'إلزامية', en ? 'Filled' : 'نسبة التعبئة'], [30, 36]);
    for (const b of d.blocks as QB[]) for (const a of b.fill) f.addRow([bn(b.block), an(b.block, a.key), a.required ? (en ? 'Yes' : 'نعم') : '', a.ratio]);
    fmtPct(f, [4]);
    const i = sheet(en ? 'Issues' : 'الملاحظات', [en ? 'Building block' : 'وحدة البناء', en ? 'Record' : 'السجل', en ? 'Issue' : 'الملاحظة', en ? 'Detail' : 'التفاصيل'], [26, 40, 30, 40]);
    for (const x of d.issues as { block: string; name: string; issue: string; detail?: string }[]) {
      const detail = x.issue === 'missing_required' ? x.detail!.split(',').map((k) => an(x.block, k)).join(en ? ', ' : '، ') : x.issue === 'low_completeness' ? `${x.detail}%` : x.detail ?? '';
      i.addRow([bn(x.block), safe(x.name), L(ISSUE[x.issue]), safe(detail)]);
    }
  }
  if (code === 'lifecycle') {
    const s = sheet(en ? 'Summary' : 'الملخص', [en ? 'Window' : 'الفترة', en ? 'Items' : 'العدد'], [26]);
    for (const k of Object.keys(BUCKET)) s.addRow([L(BUCKET[k]), (d.counts as Record<string, number>)[k]]);
    s.addRow([]);
    s.addRow([en ? 'Building block' : 'وحدة البناء', en ? 'Records' : 'السجلات', en ? 'With an end date' : 'بتاريخ انتهاء']).font = { bold: true };
    for (const x of d.tracked as { block: string; total: number; with_date: number }[]) s.addRow([bn(x.block), x.total, x.with_date]);
    const ws = sheet(en ? 'Items' : 'البنود', [en ? 'Building block' : 'وحدة البناء', en ? 'Record' : 'السجل', en ? 'Date attribute' : 'سمة التاريخ', en ? 'Date' : 'التاريخ', en ? 'Days left' : 'الأيام المتبقية', en ? 'Window' : 'الفترة', en ? 'Status' : 'الحالة'], [26, 40, 26, 14, 14, 18]);
    for (const x of d.items as { block: string; name: string; key: string; date: string; days: number; bucket: string; status: string }[]) {
      const row = ws.addRow([bn(x.block), safe(x.name), an(x.block, x.key), x.date, x.days, L(BUCKET[x.bucket]), L(STATUS[x.status])]);
      if (x.bucket === 'expired') row.getCell(6).font = { color: { argb: 'FFB3261E' }, bold: true };
    }
  }
  if (code === 'relations') {
    const ws = sheet(en ? 'Relationships' : 'العلاقات', [en ? 'Source' : 'المصدر', en ? 'Relationship' : 'العلاقة', en ? 'Target' : 'الهدف', en ? 'Links' : 'الروابط', en ? 'Source coverage' : 'تغطية المصدر'], [26, 24, 26]);
    for (const r of d.relations as { source: string; verb: string; name_ar: string | null; target: string; links: number; source_coverage: number }[]) ws.addRow([bn(r.source), en ? r.verb : r.name_ar ?? r.verb, bn(r.target), r.links, r.source_coverage]);
    fmtPct(ws, [5]);
    const b = sheet(en ? 'By block' : 'حسب الوحدة', [en ? 'Building block' : 'وحدة البناء', en ? 'Records' : 'السجلات', en ? 'Linked' : 'مرتبطة', en ? 'Coverage' : 'التغطية'], [30]);
    for (const x of d.blocks as { block: string; total: number; linked: number }[]) b.addRow([bn(x.block), x.total, x.linked, x.total ? x.linked / x.total : 0]);
    fmtPct(b, [4]);
    const o2 = sheet(en ? 'Orphans' : 'سجلات بلا علاقات', [en ? 'Building block' : 'وحدة البناء', en ? 'Record' : 'السجل', en ? 'Status' : 'الحالة'], [30, 44]);
    for (const x of d.orphans as { block: string; name: string; status: string }[]) o2.addRow([bn(x.block), safe(x.name), L(STATUS[x.status])]);
  }
  if (code === 'cost') {
    const ws = sheet(en ? 'Cost by block' : 'التكلفة حسب الوحدة', [en ? 'Building block' : 'وحدة البناء', en ? 'Records' : 'السجلات', en ? 'Capital cost' : 'التكلفة الرأسمالية', en ? 'Operating cost' : 'التكلفة التشغيلية', en ? 'Total' : 'الإجمالي', en ? 'Records with no cost' : 'سجلات بلا تكلفة'], [30, 12, 20, 20, 20]);
    type CB = { block: string; total: number; capital: number; operating: number; missing: number; top: { name: string; capital: number; operating: number }[] };
    for (const b of d.blocks as CB[]) ws.addRow([bn(b.block), b.total, b.capital, b.operating, b.capital + b.operating, b.missing]);
    ws.addRow([en ? 'Total' : 'الإجمالي', '', d.capital, d.operating, (d.capital as number) + (d.operating as number)]).font = { bold: true };
    [3, 4, 5].forEach((c) => (ws.getColumn(c).numFmt = '#,##0'));
    const top = sheet(en ? 'Largest items' : 'أعلى البنود تكلفة', [en ? 'Building block' : 'وحدة البناء', en ? 'Record' : 'السجل', en ? 'Capital cost' : 'التكلفة الرأسمالية', en ? 'Operating cost' : 'التكلفة التشغيلية'], [26, 40, 20, 20]);
    for (const b of d.blocks as CB[]) for (const x of b.top) top.addRow([bn(b.block), safe(x.name), x.capital, x.operating]);
    [3, 4].forEach((c) => (top.getColumn(c).numFmt = '#,##0'));
  }
  if (code === 'workflow') {
    const s = sheet(en ? 'Summary' : 'الملخص', [en ? 'Status' : 'الحالة', en ? 'Records' : 'السجلات'], [26]);
    for (const k of Object.keys(d.counts)) s.addRow([L(STATUS[k]), (d.counts as Record<string, number>)[k]]);
    s.addRow([en ? 'Oldest waiting (days)' : 'أقدم طلب منتظر (يوم)', d.oldest_waiting_days]);
    s.addRow([en ? 'Median waiting (days)' : 'الوسيط (يوم)', d.median_waiting_days]);
    const ws = sheet(en ? 'Queue' : 'الطابور', [en ? 'Building block' : 'وحدة البناء', en ? 'Record' : 'السجل', en ? 'Status' : 'الحالة', en ? 'Days since last change' : 'أيام منذ آخر تغيير'], [26, 44, 20]);
    for (const x of d.items as { block: string; name: string; status: string; days: number }[]) ws.addRow([bn(x.block), safe(x.name), L(STATUS[x.status]), x.days]);
  }
}


