import {
  BadRequestException, Controller, Get, Post, Query, Res, UploadedFile, UseInterceptors, UnprocessableEntityException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { COST_KEYS, can, inScope } from '../auth/permissions.js';
import { BlockDef, loadModel } from '../metamodel/metamodel.js';
import { RecordsService } from '../records/records.js';

const META = '_bunyan';
const HEADER_ROWS = 2; // row 1: Arabic label, row 2: attribute key (hidden)

/** Neutralise spreadsheet formula injection in exported text. */
const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('text' in v) return (v as { text: string }).text;
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  }
  return v;
}

@Controller('io')
export class ExcelController {
  constructor(private records: RecordsService) {}

  /** FR: download the data-entry template (optionally with current records) for one or more building blocks. */
  @Perm('records.read')
  @Get('export')
  async export(@CurrentUser() u: SessionUser, @Query('blocks') blocks: string, @Query('withData') withData: string, @Res() res: Response) {
    const codes = (blocks ?? '').split(',').filter(Boolean);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Bunyan';
    const meta = wb.addWorksheet(META, { state: 'veryHidden' });
    await withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const chosen = m.blocks.filter((b) => b.active && (codes.length ? codes.includes(b.code) : true)
        && inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code));
      if (!chosen.length) throw new BadRequestException('لا توجد وحدات بناء متاحة');
      for (const b of chosen) {
        const attrs = b.attributes.filter((a) => a.active && (can(u.roles, 'cost.read') || !COST_KEYS.test(a.key)));
        const name = `${b.name_ar}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
        const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: HEADER_ROWS }] });
        meta.addRow([name, b.code]);
        ws.addRow(['المعرّف (لا تعدّله)', ...attrs.map((a) => `${a.name_ar}${a.required ? ' *' : ''}`)]);
        ws.addRow(['id', ...attrs.map((a) => a.key)]).hidden = true;
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E5F' } };
        ws.columns.forEach((c) => (c.width = 24));
        ws.getColumn(1).hidden = true;
        attrs.forEach((a, i) => {
          const col = ws.getColumn(i + 2);
          if (a.type === 'date') col.numFmt = 'yyyy-mm-dd';
          const note = [a.name_en, a.description ?? ''].filter(Boolean).join(' — ');
          if (note) ws.getCell(1, i + 2).note = note;
          if (a.type === 'enum' && a.options?.length) {
            const list = a.options.map((o) => o.value).join(',');
            if (list.length < 250) for (let r = HEADER_ROWS + 1; r <= 2000; r++) {
              ws.getCell(r, i + 2).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list}"`] };
            }
          }
        });
        if (withData === 'true') {
          const rows = (await tx.query(`select id, attrs from records where block_code=$1 and status <> 'archived' order by name`, [b.code])).rows;
          for (const r of rows) ws.addRow([r.id, ...attrs.map((a) => {
            const v = r.attrs[a.key];
            return safe(Array.isArray(v) ? v.join('; ') : v);
          })]);
        }
      }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bunyan-template.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  /**
   * FR: import a filled template. All-or-nothing: if any row fails validation nothing is saved,
   * and the response lists every error by sheet / row / attribute. `dryRun=true` only validates.
   */
  @Perm('records.import')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async import(@CurrentUser() u: SessionUser, @UploadedFile() file: Express.Multer.File, @Query('dryRun') dryRun: string) {
    if (!file?.buffer) throw new BadRequestException('أرفق ملف Excel');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const meta = wb.getWorksheet(META);
    if (!meta) throw new BadRequestException('الملف ليس من قوالب بُنيان؛ نزّل القالب من المنصة');
    const map = new Map<string, string>();
    meta.eachRow((row) => map.set(String(cellValue(row.getCell(1).value)), String(cellValue(row.getCell(2).value))));
    const errors: { sheet: string; row: number; key?: string; message: string }[] = [];
    let created = 0, updated = 0;

    await withActor(actorOf(u), async (tx) => {
      await tx.query('savepoint imp');
      const model = await loadModel(tx);
      for (const ws of wb.worksheets) {
        const code = map.get(ws.name);
        if (!code) continue;
        const block = model.blocks.find((b) => b.code === code) as BlockDef | undefined;
        if (!block) { errors.push({ sheet: ws.name, row: 0, message: 'وحدة بناء غير معروفة' }); continue; }
        const keys = (ws.getRow(2).values as ExcelJS.CellValue[]).slice(1).map((v) => String(cellValue(v) ?? ''));
        for (let r = HEADER_ROWS + 1; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          const values: Record<string, unknown> = {};
          let id = '';
          keys.forEach((k, i) => {
            const v = cellValue(row.getCell(i + 1).value);
            if (k === 'id') id = v ? String(v) : '';
            else if (k) values[k] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
          });
          if (!id && Object.values(values).every((v) => v === undefined || v === '')) continue; // blank row
          await tx.query('savepoint row_sp');
          try {
            if (id) {
              const cur = (await tx.query('select version from records where id=$1 and block_code=$2', [id, code])).rows[0];
              if (!cur) throw new BadRequestException('المعرّف غير موجود');
              await this.records.update(tx, u, id, values, cur.version);
              updated++;
            } else {
              await this.records.create(tx, u, code, values, 'excel');
              created++;
            }
            await tx.query('release savepoint row_sp');
          } catch (e) {
            await tx.query('rollback to savepoint row_sp');
            const resp = (e as { getResponse?: () => { errors?: { key: string; message: string }[]; message?: string } }).getResponse?.();
            if (resp?.errors?.length) resp.errors.forEach((x) => errors.push({ sheet: ws.name, row: r, key: x.key, message: x.message }));
            else errors.push({ sheet: ws.name, row: r, message: resp?.message ?? (e as Error).message });
          }
        }
      }
      if (errors.length || dryRun === 'true') await tx.query('rollback to savepoint imp');
    });
    const report = { dryRun: dryRun === 'true', created, updated, errors };
    if (errors.length) throw new UnprocessableEntityException({ message: 'لم يُحفظ أي سجل بسبب الأخطاء', ...report, created: 0, updated: 0 });
    return report;
  }
}
