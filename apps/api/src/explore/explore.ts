import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { pool, Tx, withActor } from '../common/db.js';
import { CurrentUser, Perm, Public, SessionUser, actorOf } from '../auth/auth.js';
import { COST_KEYS, can, inScope } from '../auth/permissions.js';
import { Model, loadModel } from '../metamodel/metamodel.js';

/** Blocks the user may read (role scope + block switched on). Everything here filters through it, so nothing leaks across scopes. */
function readableBlocks(u: SessionUser, m: Model) {
  return new Set(m.blocks.filter((b) => b.active && inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code)).map((b) => b.code));
}

const like = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;

const SearchQuery = z.object({ q: z.string().trim().min(2).max(200), limit: z.coerce.number().int().min(1).max(100).default(30) });
const ImpactQuery = z.object({ depth: z.coerce.number().int().min(1).max(4).default(2) });

/** Keys whose values changed between two attribute maps; cost fields are hidden from roles without cost access. */
function diffAttrs(before: Record<string, unknown> = {}, after: Record<string, unknown> = {}, showCost: boolean) {
  const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: { key: string; before: unknown; after: unknown }[] = [];
  for (const k of keys) {
    if (!showCost && COST_KEYS.test(k)) continue;
    const a = before[k], b = after[k];
    if (empty(a) && empty(b)) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ key: k, before: empty(a) ? null : a, after: empty(b) ? null : b });
  }
  return out;
}

@Controller()
export class ExploreController {
  /** Liveness + database reachability, for container health checks and load balancers. No data, no auth. */
  @Public()
  @Get('health')
  async health() {
    const t = Date.now();
    await pool.query('select 1');
    return { status: 'ok', db: 'ok', ms: Date.now() - t };
  }

  /** Search across every building block the user can read: names, codes and attribute values. */
  @Perm('records.read')
  @Get('search')
  search(@CurrentUser() u: SessionUser, @Query() query: unknown) {
    const p = SearchQuery.parse(query);
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const blocks = [...readableBlocks(u, m)];
      if (!blocks.length) return { total: 0, items: [] };
      const pattern = like(p.q);
      // Name hits rank first, then exact code, then anything in the attributes. Cost values are never searched for roles that cannot see them.
      const attrsText = can(u.roles, 'cost.read') ? `attrs::text` : `(select coalesce(jsonb_object_agg(k, v)::text, '') from jsonb_each(attrs) as e(k, v) where k !~* '(cost|fees|budget)')`;
      const { rows } = await tx.query(
        `select id, name, block_code, status, updated_at,
                case when lower(name) like $2 then 0 when lower(coalesce(attrs->>'code','')) = lower($4) then 1 else 2 end as rank,
                count(*) over () as total
           from records
          where block_code = any($1) and status <> 'archived'
            and (lower(name) like $2 or lower(${attrsText}) like $2)
          order by rank, length(name), name
          limit $3`, [blocks, pattern, p.limit, p.q]);
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, rank: _r, ...r }) => r) };
    });
  }

  /**
   * Impact analysis: everything reachable from a record through its relations, up to `depth` hops.
   * Inverse relation pairs are one fact, so the walk is undirected; it never passes through blocks the user cannot read.
   */
  @Perm('records.read')
  @Get('records/:id/impact')
  impact(@CurrentUser() u: SessionUser, @Param('id') id: string, @Query() query: unknown) {
    const p = ImpactQuery.parse(query);
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const readable = readableBlocks(u, m);
      const root = (await tx.query('select id, name, block_code, status from records where id=$1', [id])).rows[0];
      if (!root || !readable.has(root.block_code)) throw new NotFoundException();
      const LIMIT = 400;
      const seen = new Map<string, { id: string; name: string; block_code: string; status: string; depth: number; via: string | null; verb: string | null; relation_ar: string | null }>();
      seen.set(root.id, { ...root, depth: 0, via: null, verb: null, relation_ar: null });
      let frontier = [root.id as string];
      let truncated = false;
      for (let depth = 1; depth <= p.depth && frontier.length && !truncated; depth++) {
        const { rows } = await tx.query(
          `select case when l.source_id = any($1) then l.source_id else l.target_id end as from_id,
                  o.id, o.name, o.block_code, o.status, mr.verb, mr.name_ar as relation_ar
             from record_links l
             join mm_relations mr on mr.id = l.relation_id
             join records o on o.id = case when l.source_id = any($1) then l.target_id else l.source_id end
            where (l.source_id = any($1) or l.target_id = any($1)) and o.status <> 'archived' and o.block_code = any($2)
            order by o.name`, [frontier, [...readable]]);
        const next: string[] = [];
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          if (seen.size >= LIMIT) { truncated = true; break; }
          seen.set(r.id, { id: r.id, name: r.name, block_code: r.block_code, status: r.status, depth, via: r.from_id, verb: r.verb, relation_ar: r.relation_ar });
          next.push(r.id);
        }
        frontier = next;
      }
      const nodes = [...seen.values()].filter((n) => n.depth > 0);
      const byBlock: Record<string, number> = {};
      for (const n of nodes) byBlock[n.block_code] = (byBlock[n.block_code] ?? 0) + 1;
      return { root, depth: p.depth, truncated, total: nodes.length, byBlock, nodes };
    });
  }

  /** What changed in a record over time: field-level differences from the audit log, plus links added and removed. */
  @Perm('records.read')
  @Get('records/:id/changes')
  changes(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const m = await loadModel(tx);
      const rec = (await tx.query('select id, block_code from records where id=$1', [id])).rows[0];
      if (!rec || !readableBlocks(u, m).has(rec.block_code)) throw new NotFoundException();
      return changesOf(tx, id, can(u.roles, 'cost.read'));
    });
  }
}

async function changesOf(tx: Tx, id: string, showCost: boolean) {
  const { rows } = await tx.query(
    `select a.id, a.action, a.entity, a.before, a.after, a.at, u.display_name as user_name
       from audit_log a left join users u on u.id = a.user_id
      where (a.entity = 'record' and a.entity_id = $1)
         or (a.entity = 'record_link' and ($1 in (a.after->>'source_id', a.after->>'target_id', a.before->>'source_id', a.before->>'target_id')))
      order by a.id desc limit 200`, [id]);
  // Name the other end of each link once.
  const others = new Set<string>();
  for (const r of rows) if (r.entity === 'record_link') {
    const l = r.after ?? r.before;
    others.add(l.source_id === id ? l.target_id : l.source_id);
  }
  const names = new Map<string, { name: string; block_code: string }>(
    others.size ? (await tx.query('select id, name, block_code from records where id = any($1)', [[...others]])).rows.map((x) => [x.id, x]) : []);
  return rows.map((r) => {
    const base = { id: r.id, action: r.action, at: r.at, user_name: r.user_name };
    if (r.entity === 'record_link') {
      const l = r.after ?? r.before;
      const other = l.source_id === id ? l.target_id : l.source_id;
      return { ...base, other: { id: other, ...(names.get(other) ?? { name: null, block_code: null }) } };
    }
    if (r.action === 'create') return { ...base, fields: diffAttrs({}, r.after?.attrs ?? {}, showCost) };
    if (r.action === 'update') return { ...base, fields: diffAttrs(r.before?.attrs ?? {}, r.after?.attrs ?? {}, showCost) };
    return { ...base, status: r.after?.status ?? null, comment: r.after?.comment ?? null };
  });
}
