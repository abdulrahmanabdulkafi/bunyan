import {
  BadRequestException, Body, Controller, ForbiddenException, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Tx, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { can, inScope } from '../auth/permissions.js';
import { BlockDef, RelationDef, loadModel } from '../metamodel/metamodel.js';
import { RecordsService } from '../records/records.js';

/**
 * Import wizard for any spreadsheet (FR-03): the entity's own files, not only Bunyan templates.
 * 1. inspect — sheets, a raw preview to choose the header row, and the columns with sample values;
 * 2. run    — with a column mapping (attributes and relationships), as a dry run first, then for real.
 * Rows are matched to existing records by a chosen key (the display name by default), so re-importing a
 * corrected file updates rather than duplicates.
 */

const MAX_ROWS = 20_000;

function text(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return text(v.result as ExcelJS.CellValue);
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text ?? '');
    if ('hyperlink' in v) return String((v as { hyperlink: string }).hyperlink);
    if ('error' in v) return '';
  }
  return String(v).trim();
}
function raw(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return raw(v.result as ExcelJS.CellValue);
    return text(v);
  }
  return typeof v === 'string' ? v.trim() : v;
}

async function load(file?: Express.Multer.File) {
  if (!file?.buffer) throw new BadRequestException('أرفق ملف Excel');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file.buffer as unknown as ArrayBuffer); }
  catch { throw new BadRequestException('تعذّر قراءة الملف؛ احفظه بصيغة .xlsx وأعد المحاولة'); }
  return wb;
}

/** Normalise a label for fuzzy column ↔ attribute matching (Arabic letter variants, case, punctuation). */
export function norm(s: string): string {
  return s.toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(ال)/, '').trim();
}

const Mapping = z.object({
  sheet: z.string(),
  header_row: z.number().int().min(1).max(200),
  block: z.string(),
  /** column index (1-based) → attribute key, or "rel:<relation id>" for a column of related record names */
  columns: z.record(z.string(), z.string()),
  match_on: z.string().default('__title__'),
  mode: z.enum(['create_update', 'create_only', 'update_only']).default('create_update'),
  on_error: z.enum(['all_or_nothing', 'skip_rows']).default('all_or_nothing'),
  create_missing_links: z.boolean().default(false),
  dry_run: z.boolean().default(true),
});

interface RowIssue { row: number; column?: string; message: string; kind: 'error' | 'warning' }

@Controller('io/wizard')
export class ImportWizardController {
  constructor(private records: RecordsService) {}

  @Perm('records.import')
  @Post('inspect')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async inspect(@UploadedFile() file: Express.Multer.File, @Body() body: { sheet?: string; header_row?: string }) {
    const wb = await load(file);
    const sheets = wb.worksheets.filter((w) => w.state === 'visible').map((ws) => {
      const preview: string[][] = [];
      for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
        const row = ws.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= Math.min(ws.columnCount, 40); c++) cells.push(text(row.getCell(c).value).slice(0, 80));
        preview.push(cells);
      }
      // Header guess: the first of the top rows with the most non-empty text cells.
      let guess = 1, best = -1;
      preview.forEach((cells, i) => {
        const n = cells.filter((c) => c && isNaN(Number(c))).length;
        if (n > best) { best = n; guess = i + 1; }
      });
      return { name: ws.name, rows: ws.rowCount, columns: ws.columnCount, header_guess: guess, preview };
    });
    if (!sheets.length) throw new BadRequestException('لا توجد أوراق في الملف');
    const pick = sheets.find((s) => s.name === body?.sheet) ?? sheets[0];
    const ws = wb.getWorksheet(pick.name)!;
    const hr = Number(body?.header_row) || pick.header_guess;
    const columns = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const header = text(ws.getRow(hr).getCell(c).value);
      const samples: string[] = [];
      let filled = 0;
      for (let r = hr + 1; r <= ws.rowCount; r++) {
        const v = text(ws.getRow(r).getCell(c).value);
        if (v) { filled++; if (samples.length < 4 && !samples.includes(v)) samples.push(v.slice(0, 60)); }
      }
      if (header || filled) columns.push({ index: c, header: header || `#${c}`, samples, filled });
    }
    return { sheets, sheet: pick.name, header_row: hr, data_rows: Math.max(0, ws.rowCount - hr), columns };
  }

  @Perm('records.import')
  @Post('run')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async run(@CurrentUser() u: SessionUser, @UploadedFile() file: Express.Multer.File, @Body() body: { mapping?: string }) {
    let m: z.infer<typeof Mapping>;
    try { m = Mapping.parse(JSON.parse(body?.mapping ?? '{}')); } catch { throw new BadRequestException('مدخلات غير صالحة'); }
    const wb = await load(file);
    const ws = wb.getWorksheet(m.sheet);
    if (!ws) throw new BadRequestException('الورقة غير موجودة');
    if (ws.rowCount - m.header_row > MAX_ROWS) throw new BadRequestException(`الحد الأقصى ${MAX_ROWS} صف في الاستيراد الواحد`);

    return withActor(actorOf(u), async (tx) => {
      const model = await loadModel(tx);
      const block = model.blocks.find((b) => b.code === m.block);
      if (!block?.active) throw new BadRequestException('وحدة البناء غير مفعّلة في جهتك');
      if (!inScope(u.roles, u.scope ?? {}, 'records.import', block.code, block.domain_code)) throw new ForbiddenException('خارج نطاق صلاحياتك');
      const attrCols: [number, string][] = [];
      const relCols: [number, RelationDef, 'out' | 'in'][] = [];
      for (const [col, target] of Object.entries(m.columns)) {
        if (!target) continue;
        if (target.startsWith('rel:')) {
          const rel = model.relations.find((r) => r.id === target.slice(4) && r.active);
          if (!rel || (rel.source_code !== block.code && rel.target_code !== block.code)) throw new BadRequestException('العلاقة غير معرّفة');
          relCols.push([Number(col), rel, rel.source_code === block.code ? 'out' : 'in']);
        } else {
          if (!block.attributes.some((a) => a.key === target && a.active)) throw new BadRequestException(`سمة غير معرّفة في هذه الوحدة: ${target}`);
          attrCols.push([Number(col), target]);
        }
      }
      const titleKey = block.title_key ?? 'name';
      const matchKey = m.match_on === '__title__' ? titleKey : m.match_on;
      if (!attrCols.some(([, k]) => k === matchKey)) throw new BadRequestException('اربط عموداً بسمة المطابقة');
      const headers = new Map<number, string>();
      for (const [c] of [...attrCols, ...relCols]) headers.set(c, text(ws.getRow(m.header_row).getCell(c).value) || `#${c}`);

      const issues: RowIssue[] = [];
      let created = 0, updated = 0, unchanged = 0, skipped = 0, linked = 0;
      const seenKeys = new Map<string, number>();
      await tx.query('savepoint wizard');
      for (let r = m.header_row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const values: Record<string, unknown> = {};
        for (const [c, key] of attrCols) {
          const a = block.attributes.find((x) => x.key === key)!;
          let v = raw(row.getCell(c).value);
          // "16 GB", "1,200 ريال": keep the number when the attribute is numeric.
          if (a.type === 'number' && typeof v === 'string') {
            const n = v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).match(/-?\d[\d,]*(\.\d+)?/);
            if (n) v = n[0].replace(/,/g, '');
          }
          if (v !== '' && v !== null && v !== undefined) values[key] = v;
        }
        const relValues = relCols.map(([c, rel, dir]) => ({ rel, dir, col: c, names: text(row.getCell(c).value).split(/[;\n؛]|\s،\s/).map((x) => x.trim()).filter(Boolean) }));
        if (!Object.keys(values).length && relValues.every((x) => !x.names.length)) continue; // blank row
        const keyVal = String(values[matchKey] ?? '').trim();
        if (!keyVal) { issues.push({ row: r, column: headers.get(attrCols.find(([, k]) => k === matchKey)![0]), message: 'قيمة المطابقة فارغة', kind: 'error' }); continue; }
        const dupOf = seenKeys.get(keyVal.toLowerCase());
        if (dupOf) issues.push({ row: r, message: `مكرر في الملف مع الصف ${dupOf}؛ يُحدَّث السجل نفسه`, kind: 'warning' });
        else seenKeys.set(keyVal.toLowerCase(), r);

        await tx.query('savepoint row');
        try {
          const existing = await this.find(tx, block, matchKey, keyVal);
          let id: string;
          if (existing) {
            if (m.mode === 'create_only') { skipped++; await tx.query('release savepoint row'); continue; }
            const res = await this.records.update(tx, u, existing.id, values, existing.version);
            id = res.id;
            if ((res as { unchanged?: boolean }).unchanged) unchanged++; else updated++;
          } else {
            if (m.mode === 'update_only') { skipped++; issues.push({ row: r, message: 'لا يوجد سجل مطابق؛ تخطّي', kind: 'warning' }); await tx.query('release savepoint row'); continue; }
            id = (await this.records.create(tx, u, block.code, values, 'excel')).id;
            created++;
          }
          for (const rv of relValues) {
            const other = rv.dir === 'out' ? rv.rel.target_code : rv.rel.source_code;
            const otherBlock = model.blocks.find((b) => b.code === other);
            for (const name of rv.names) {
              let target = otherBlock ? await this.find(tx, otherBlock, otherBlock.title_key ?? 'name', name) : undefined;
              if (!target && m.create_missing_links && otherBlock?.active) {
                const t = await this.records.create(tx, u, other, { [otherBlock.title_key ?? 'name']: name }, 'excel');
                target = { id: t.id, version: t.version };
              }
              if (!target) { issues.push({ row: r, column: headers.get(rv.col), message: `لم يُعثر على «${name}»`, kind: 'warning' }); continue; }
              const [s, t] = rv.dir === 'out' ? [id, target.id] : [target.id, id];
              await this.records.link(tx, u, s, rv.rel.id, t);
              linked++;
            }
          }
          await tx.query('release savepoint row');
        } catch (e) {
          await tx.query('rollback to savepoint row');
          const resp = (e as { getResponse?: () => { errors?: { key: string; message: string }[]; message?: string } }).getResponse?.();
          const colOf = (key: string) => { const c = attrCols.find(([, k]) => k === key); return c ? headers.get(c[0]) : key; };
          if (resp?.errors?.length) resp.errors.forEach((x) => issues.push({ row: r, column: colOf(x.key), message: x.message, kind: 'error' }));
          else issues.push({ row: r, message: resp?.message ?? (e as Error).message, kind: 'error' });
        }
      }
      const errors = issues.filter((i) => i.kind === 'error').length;
      const rollback = m.dry_run || (errors > 0 && m.on_error === 'all_or_nothing');
      if (rollback) await tx.query('rollback to savepoint wizard');
      return {
        dry_run: m.dry_run, saved: !rollback, created, updated, unchanged, skipped, linked,
        errors, warnings: issues.length - errors, issues: issues.slice(0, 1000),
      };
    });
  }

  private async find(tx: Tx, block: BlockDef, key: string, value: string) {
    const titleKey = block.title_key ?? 'name';
    const sql = key === titleKey
      ? `select id, version from records where block_code=$1 and status <> 'archived' and lower(trim(name)) = lower(trim($2)) order by updated_at desc limit 1`
      : `select id, version from records where block_code=$1 and status <> 'archived' and lower(trim(attrs->>'${key.replace(/[^a-z0-9_]/g, '')}')) = lower(trim($2)) order by updated_at desc limit 1`;
    return (await tx.query(sql, [block.code, value])).rows[0] as { id: string; version: number } | undefined;
  }
}

/** Approve or review many records at once (after a large import). Each record still follows the workflow rules. */
@Controller('records-bulk')
export class BulkController {
  constructor(private records: RecordsService) {}

  @Post()
  async bulk(@CurrentUser() u: SessionUser, @Body() body: { ids?: string[]; filter?: { block?: string; status?: string; q?: string }; action?: string; comment?: string }) {
    let ids: string[];
    try {
      ids = body?.ids?.length ? z.array(z.string().uuid()).max(5000).parse(body.ids) : await this.byFilter(u, body?.filter);
    } catch (e) { if (e instanceof z.ZodError) throw new BadRequestException('مدخلات غير صالحة'); throw e; }
    if (!ids.length) return { done: 0, failed: [] };
    const action = z.enum(['submit', 'review', 'approve', 'reject', 'archive']).parse(body?.action);
    if (!can(u.roles, action === 'submit' ? 'records.write' : action === 'approve' ? 'records.approve' : action === 'archive' ? 'records.archive' : 'records.review')) throw new ForbiddenException();
    const done: string[] = [];
    const failed: { id: string; message: string }[] = [];
    await withActor(actorOf(u), async (tx) => {
      for (const id of ids) {
        await tx.query('savepoint b');
        try { await this.records.transition(tx, u, id, action, body?.comment); done.push(id); await tx.query('release savepoint b'); }
        catch (e) {
          await tx.query('rollback to savepoint b');
          const resp = (e as { getResponse?: () => { message?: string } }).getResponse?.();
          failed.push({ id, message: resp?.message ?? (e as Error).message });
        }
      }
    });
    return { done: done.length, failed };
  }

  /** "Select everything that matches the list's filters" — the same filters as GET /records. */
  private async byFilter(u: SessionUser, f?: { block?: string; status?: string; q?: string }) {
    const p = z.object({ block: z.string().min(1), status: z.string().optional(), q: z.string().optional() }).parse(f ?? {});
    return withActor(actorOf(u), async (tx) => {
      const args: unknown[] = [p.block];
      let where = 'block_code=$1';
      if (p.status) { args.push(p.status); where += ` and status=$${args.length}`; } else where += ` and status <> 'archived'`;
      if (p.q) { args.push(`%${p.q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`); where += ` and (lower(name) like $${args.length} or lower(attrs::text) like $${args.length})`; }
      return (await tx.query(`select id from records where ${where} order by updated_at desc limit 5000`, args)).rows.map((r) => r.id as string);
    });
  }
}
