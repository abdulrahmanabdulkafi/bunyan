import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable,
  NotFoundException, Param, Patch, Post, Query, UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { Tx, audit, txIdOf, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { COST_KEYS, Permission, can, inScope } from '../auth/permissions.js';
import { BlockDef, loadModel } from '../metamodel/metamodel.js';
import { completeness, validateAttrs } from './validate.js';

/** Approval workflow — BRD 4.x: draft → submitted → reviewed (preliminary) → approved (final). */
const TRANSITIONS: Record<string, { from: string[]; to: string; perm: Permission }> = {
  submit: { from: ['draft', 'rejected'], to: 'submitted', perm: 'records.write' },
  review: { from: ['submitted'], to: 'reviewed', perm: 'records.review' },
  approve: { from: ['reviewed'], to: 'approved', perm: 'records.approve' },
  reject: { from: ['submitted', 'reviewed'], to: 'rejected', perm: 'records.review' },
  archive: { from: ['draft', 'submitted', 'reviewed', 'approved', 'rejected'], to: 'archived', perm: 'records.archive' },
  restore: { from: ['archived'], to: 'draft', perm: 'records.archive' },
};

export function stripCost(u: SessionUser, r: { attrs: Record<string, unknown> }) {
  if (can(u.roles, 'cost.read')) return r;
  return { ...r, attrs: Object.fromEntries(Object.entries(r.attrs).filter(([k]) => !COST_KEYS.test(k))) };
}

@Injectable()
export class RecordsService {
  // One transaction sees one meta-model: cache it per transaction (bulk imports call this per row).
  private models = new WeakMap<Tx, { id: number; p: Promise<Awaited<ReturnType<typeof loadModel>>> }>();
  async block(tx: Tx, code: string): Promise<BlockDef> {
    let c = this.models.get(tx);
    if (!c || c.id !== txIdOf(tx)) { c = { id: txIdOf(tx), p: loadModel(tx) }; this.models.set(tx, c); }
    const m = await c.p;
    const b = m.blocks.find((x) => x.code === code);
    if (!b) throw new NotFoundException('وحدة البناء غير موجودة');
    return b;
  }

  guard(u: SessionUser, perm: Permission, b: BlockDef) {
    if (!can(u.roles, perm) || !inScope(u.roles, u.scope ?? {}, perm, b.code, b.domain_code)) {
      throw new ForbiddenException('خارج نطاق صلاحياتك');
    }
  }

  titleOf(b: BlockDef, attrs: Record<string, unknown>) {
    const t = b.title_key ? attrs[b.title_key] : undefined;
    return String(t ?? attrs.name ?? attrs.code ?? '').slice(0, 300);
  }

  async create(tx: Tx, u: SessionUser, blockCode: string, input: Record<string, unknown>, source = 'manual') {
    const b = await this.block(tx, blockCode);
    if (!b.active) throw new BadRequestException('وحدة البناء غير مفعّلة في جهتك');
    this.guard(u, 'records.write', b);
    const { attrs, errors } = validateAttrs(b, input);
    if (errors.length) throw new UnprocessableEntityException({ message: 'أخطاء في البيانات', errors });
    const { rows } = await tx.query(
      `insert into records (tenant_id, block_code, name, attrs, source, created_by, updated_by)
       values (app_tenant(), $1, $2, $3, $4, app_user(), app_user()) returning *`,
      [b.code, this.titleOf(b, attrs), JSON.stringify(attrs), source]);
    await audit(tx, actorOf(u), 'create', 'record', rows[0].id, null, rows[0]);
    return rows[0];
  }

  async update(tx: Tx, u: SessionUser, id: string, input: Record<string, unknown>, version: number) {
    const cur = (await tx.query('select * from records where id=$1 for update', [id])).rows[0];
    if (!cur) throw new NotFoundException();
    const b = await this.block(tx, cur.block_code);
    this.guard(u, 'records.write', b);
    if (cur.status === 'archived') throw new BadRequestException('السجل مؤرشف');
    if (cur.version !== version) throw new ConflictException('عدّل مستخدم آخر هذا السجل؛ حدّث الصفحة');
    // Users without cost.read cannot see cost fields, so keep the stored values for those keys.
    const merged = { ...cur.attrs, ...input };
    if (!can(u.roles, 'cost.read')) for (const k of Object.keys(cur.attrs)) if (COST_KEYS.test(k)) merged[k] = cur.attrs[k];
    const { attrs, errors } = validateAttrs(b, merged);
    if (errors.length) throw new UnprocessableEntityException({ message: 'أخطاء في البيانات', errors });
    // A save that changes nothing (e.g. re-importing the same file) must not send an approved record back to draft.
    if (stable(attrs) === stable(cur.attrs)) return { ...cur, unchanged: true };
    // Editing an approved/submitted record sends it back to draft so the change is re-approved.
    const { rows } = await tx.query(
      `update records set attrs=$2, name=$3, version=version+1, status='draft', updated_by=app_user(), updated_at=now() where id=$1 returning *`,
      [id, JSON.stringify(attrs), this.titleOf(b, attrs)]);
    await audit(tx, actorOf(u), 'update', 'record', id, cur, rows[0]);
    return rows[0];
  }

  async transition(tx: Tx, u: SessionUser, id: string, action: string, comment?: string) {
    const t = TRANSITIONS[action];
    if (!t) throw new BadRequestException('إجراء غير معروف');
    const cur = (await tx.query('select * from records where id=$1 for update', [id])).rows[0];
    if (!cur) throw new NotFoundException();
    const b = await this.block(tx, cur.block_code);
    this.guard(u, t.perm, b);
    if (!t.from.includes(cur.status)) throw new BadRequestException(`لا يمكن تنفيذ "${action}" على سجل حالته ${cur.status}`);
    // Maker-checker: whoever last edited a record cannot review or approve it.
    if ((action === 'review' || action === 'approve') && cur.updated_by === u.id) {
      throw new ForbiddenException('لا يمكن اعتماد سجل قمت بتعديله (مبدأ الفصل بين المهام)');
    }
    if (action === 'reject' && !comment?.trim()) throw new BadRequestException('سبب الرفض مطلوب');
    const { rows } = await tx.query(`update records set status=$2, updated_at=now() where id=$1 returning *`, [id, t.to]);
    await tx.query(`insert into approvals (tenant_id, record_id, from_status, to_status, actor_id, comment) values (app_tenant(),$1,$2,$3,app_user(),$4)`,
      [id, cur.status, t.to, comment ?? null]);
    await audit(tx, actorOf(u), action, 'record', id, { status: cur.status }, { status: t.to, comment });
    return rows[0];
  }

  async link(tx: Tx, u: SessionUser, sourceId: string, relationId: string, targetId: string) {
    const rel = (await tx.query('select * from mm_relations where id=$1 and active', [relationId])).rows[0];
    if (!rel) throw new BadRequestException('العلاقة غير معرّفة');
    const recs = (await tx.query('select id, block_code from records where id = any($1)', [[sourceId, targetId]])).rows;
    const s = recs.find((r) => r.id === sourceId), t = recs.find((r) => r.id === targetId);
    if (!s || !t) throw new NotFoundException();
    if (s.block_code !== rel.source_code || t.block_code !== rel.target_code) throw new BadRequestException('نوع السجلين لا يطابق تعريف العلاقة');
    this.guard(u, 'records.write', await this.block(tx, s.block_code));
    const { rows } = await tx.query(
      `insert into record_links (tenant_id, relation_id, source_id, target_id, created_by) values (app_tenant(),$1,$2,$3,app_user())
       on conflict (relation_id, source_id, target_id) do update set relation_id = excluded.relation_id returning *`,
      [relationId, sourceId, targetId]);
    await audit(tx, actorOf(u), 'link', 'record_link', rows[0].id, null, rows[0]);
    return rows[0];
  }
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== null && (v as Record<string, unknown>)[k] !== '').map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}`;
  return JSON.stringify(v);
}

const ListQuery = z.object({
  block: z.string(), q: z.string().optional(), status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50),
});

@Controller('records')
export class RecordsController {
  constructor(private svc: RecordsService) {}

  @Perm('records.read')
  @Get()
  list(@CurrentUser() u: SessionUser, @Query() query: unknown) {
    const p = ListQuery.parse(query);
    return withActor(actorOf(u), async (tx) => {
      const b = await this.svc.block(tx, p.block);
      this.svc.guard(u, 'records.read', b);
      const args: unknown[] = [p.block];
      let where = 'block_code = $1';
      if (p.status) { args.push(p.status); where += ` and status = $${args.length}`; } else where += ` and status <> 'archived'`;
      if (p.q) { args.push(`%${p.q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`); where += ` and (lower(name) like $${args.length} or lower(attrs::text) like $${args.length})`; }
      const total = Number((await tx.query(`select count(*) from records where ${where}`, args)).rows[0].count);
      args.push(p.size, (p.page - 1) * p.size);
      const rows = (await tx.query(`select * from records where ${where} order by updated_at desc limit $${args.length - 1} offset $${args.length}`, args)).rows;
      return { total, page: p.page, size: p.size, items: rows.map((r) => ({ ...stripCost(u, r), completeness: completeness(b, r.attrs) })) };
    });
  }

  @Perm('records.read')
  @Get(':id')
  get(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const r = (await tx.query('select * from records where id=$1', [id])).rows[0];
      if (!r) throw new NotFoundException();
      const b = await this.svc.block(tx, r.block_code);
      this.svc.guard(u, 'records.read', b);
      const links = (await tx.query(
        `select l.id, l.relation_id, m.verb, m.name_ar as relation_ar, m.source_code, m.target_code,
                case when l.source_id = $1 then 'out' else 'in' end as direction,
                o.id as other_id, o.name as other_name, o.block_code as other_block, o.status as other_status
           from record_links l join mm_relations m on m.id = l.relation_id
           join records o on o.id = case when l.source_id = $1 then l.target_id else l.source_id end
          where l.source_id = $1 or l.target_id = $1 order by m.verb, o.name`, [id])).rows;
      const history = (await tx.query(
        `select a.*, u.display_name as actor_name from approvals a left join users u on u.id = a.actor_id where record_id=$1 order by created_at desc`, [id])).rows;
      return { ...stripCost(u, r), completeness: completeness(b, r.attrs), links, history };
    });
  }

  @Perm('records.write')
  @Post()
  create(@CurrentUser() u: SessionUser, @Body() body: { block: string; attrs: Record<string, unknown> }) {
    if (!body?.block) throw new BadRequestException('block required');
    return withActor(actorOf(u), (tx) => this.svc.create(tx, u, body.block, body.attrs ?? {}));
  }

  @Perm('records.write')
  @Patch(':id')
  update(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { attrs: Record<string, unknown>; version: number }) {
    return withActor(actorOf(u), (tx) => this.svc.update(tx, u, id, body.attrs ?? {}, Number(body.version)));
  }

  @Perm('records.write')
  @Post(':id/links')
  link(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { relation_id: string; target_id: string }) {
    return withActor(actorOf(u), (tx) => this.svc.link(tx, u, id, body.relation_id, body.target_id));
  }

  @Perm('records.write')
  @Delete(':id/links/:linkId')
  unlink(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('linkId') linkId: string) {
    return withActor(actorOf(u), async (tx) => {
      const before = (await tx.query('delete from record_links where id=$1 and (source_id=$2 or target_id=$2) returning *', [linkId, id])).rows[0];
      if (!before) throw new NotFoundException();
      await audit(tx, actorOf(u), 'unlink', 'record_link', linkId, before, null);
      return { ok: true };
    });
  }

  // Declared last so it never shadows /:id/links.
  @Post(':id/:action')
  transition(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('action') action: string, @Body() body: { comment?: string }) {
    return withActor(actorOf(u), (tx) => this.svc.transition(tx, u, id, action, body?.comment));
  }
}

@Controller('approvals')
export class ApprovalsController {
  /** My queue: records waiting for an action my roles allow. */
  @Get('queue')
  queue(@CurrentUser() u: SessionUser) {
    const statuses = [
      ...(can(u.roles, 'records.review') ? ['submitted'] : []),
      ...(can(u.roles, 'records.approve') ? ['reviewed'] : []),
    ];
    if (!statuses.length) return [];
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const rows = (await tx.query(
        `select r.id, r.name, r.block_code, r.status, r.updated_at, r.updated_by, u.display_name as updated_by_name
           from records r left join users u on u.id = r.updated_by where r.status = any($1) order by r.updated_at`, [statuses])).rows;
      return rows.filter((r) => {
        const b = m.blocks.find((x) => x.code === r.block_code)!;
        const perm: Permission = r.status === 'submitted' ? 'records.review' : 'records.approve';
        return inScope(u.roles, u.scope ?? {}, perm, b.code, b.domain_code);
      });
    });
  }

  @Perm('audit.read')
  @Get('audit')
  audit(@CurrentUser() u: SessionUser, @Query('entity_id') entityId?: string) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select a.*, u.display_name as user_name from audit_log a left join users u on u.id = a.user_id
        where ($1::text is null or a.entity_id = $1) order by a.id desc limit 500`, [entityId ?? null])).rows);
  }
}
