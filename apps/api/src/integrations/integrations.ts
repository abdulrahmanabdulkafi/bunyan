import crypto from 'node:crypto';
import {
  BadRequestException, Body, Controller, Delete, Get, Headers, Injectable, NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import { config } from '../common/config.js';
import { Actor, Tx, audit, pool, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { loadModel } from '../metamodel/metamodel.js';
import { validateAttrs } from '../records/validate.js';
import { CONNECTOR_TYPES, ConnectorType, FieldMap, applyTransform } from './connectors.js';
import { pick } from './http.js';
import { langOf, trBody } from '../common/i18n.js';

// ───────────── Credentials at rest: AES-256-GCM (FR-05-10) ─────────────
function key(): Buffer {
  if (config.connectorKey) {
    const k = Buffer.from(config.connectorKey, 'base64');
    if (k.length !== 32) throw new Error('CONNECTOR_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  return crypto.createHash('sha256').update(`bunyan-connectors:${config.jwtSecret}`).digest();
}
export function seal(obj: Record<string, string>): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
export function unseal(s: string | null): Record<string, string> {
  if (!s) return {};
  const [v, iv, tag, data] = s.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

// ───────────── Configuration ─────────────
const FieldMapDto = z.object({ from: z.string().min(1), to: z.string().min(1), transform: z.enum(['none', 'mib_to_gb', 'bytes_to_gb', 'upper', 'lower']).optional() });
const TargetDto = z.object({
  entity: z.string(),
  block: z.string(),
  enabled: z.boolean().default(true),
  /** Source of truth per mapping (FR-05-06): overwrite = the source wins; fill_empty = the repository wins and differences are reported. */
  mode: z.enum(['overwrite', 'fill_empty']).default('overwrite'),
  fields: z.array(FieldMapDto),
});
const CreateDto = z.object({
  name: z.string().min(2).max(120),
  type: z.string(),
  settings: z.record(z.string(), z.unknown()).default({}),
  secret: z.record(z.string(), z.string()).default({}),
  targets: z.array(TargetDto).optional(),
  schedule_minutes: z.number().int().min(15).nullable().default(null),
  auto_approve: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
const PatchDto = z.object({
  name: z.string().min(2).max(120), settings: z.record(z.string(), z.unknown()), secret: z.record(z.string(), z.string()),
  targets: z.array(TargetDto), schedule_minutes: z.number().int().min(15).nullable(), auto_approve: z.boolean(), enabled: z.boolean(),
}).partial();

interface ConnectorRow {
  id: string; tenant_id: string; name: string; type: string; secret: string | null; schedule_minutes: number | null;
  auto_approve: boolean; enabled: boolean; last_run_at: string | null;
  config: { settings: Record<string, unknown>; targets: z.infer<typeof TargetDto>[] };
}

function typeOf(t: string): ConnectorType {
  const ct = CONNECTOR_TYPES[t];
  if (!ct) throw new BadRequestException('نوع موصّل غير معروف');
  return ct;
}

/** Strip secret values: the API only says whether a secret is stored. */
function view(c: ConnectorRow & Record<string, unknown>) {
  const { secret, ...rest } = c;
  return { ...rest, has_secret: !!secret };
}

export interface RunSummary { id: string | null; status: string; created: number; updated: number; unchanged: number; conflicts: number; details: unknown[] }

@Injectable()
export class IntegrationsService {
  async get(tx: Tx, id: string): Promise<ConnectorRow> {
    const c = (await tx.query('select * from connectors where id=$1', [id])).rows[0];
    if (!c) throw new NotFoundException();
    return c;
  }

  /**
   * Pull from the source and upsert into the repository.
   * Matching: first by the source's own id (record_sources), then by display name within the block, so a record
   * typed in by hand is merged rather than duplicated. Synced data enters as drafts unless auto-approve is on.
   */
  async sync(actor: Actor, id: string, trigger: 'manual' | 'schedule' | 'dry_run'): Promise<RunSummary> {
    const dry = trigger === 'dry_run';
    const conn = await withActor(actor, (tx) => this.get(tx, id));
    const ct = typeOf(conn.type);
    const runId = dry ? null : await withActor(actor, async (tx) =>
      (await tx.query(`insert into connector_runs (tenant_id, connector_id, trigger, started_by) values (app_tenant(),$1,$2,app_user()) returning id`, [id, trigger])).rows[0].id as string);
    const sum: RunSummary = { id: runId, status: 'succeeded', created: 0, updated: 0, unchanged: 0, conflicts: 0, details: [] };
    const note = (d: Record<string, unknown>) => { if (sum.details.length < 500) sum.details.push(d); };

    try {
      const secret = unseal(conn.secret);
      // Fetch everything first: a source failure leaves the repository untouched.
      const fetched: { target: z.infer<typeof TargetDto>; items: Awaited<ReturnType<ConnectorType['fetch']>> }[] = [];
      for (const target of conn.config.targets ?? []) {
        if (!target.enabled) continue;
        fetched.push({ target, items: await ct.fetch(conn.config.settings ?? {}, secret, target.entity) });
      }
      await withActor(actor, async (tx) => {
        if (dry) await tx.query('savepoint dry');
        const model = await loadModel(tx);
        for (const { target, items } of fetched) {
          const block = model.blocks.find((b) => b.code === target.block);
          if (!block?.active) { note({ kind: 'error', message: `وحدة البناء ${target.block} غير مفعّلة` }); continue; }
          for (const item of items) await this.upsert(tx, conn, block, target.fields, target.mode, item, sum, note);
        }
        if (dry) await tx.query('rollback to savepoint dry');
        else await tx.query('update connectors set last_run_at = now() where id=$1', [id]);
      });
    } catch (e) {
      sum.status = 'failed';
      note({ kind: 'error', message: (e as Error).message });
    }
    if (runId) {
      await withActor(actor, async (tx) => {
        await tx.query(`update connector_runs set status=$2, created=$3, updated=$4, unchanged=$5, conflicts=$6, details=$7, finished_at=now() where id=$1`,
          [runId, sum.status, sum.created, sum.updated, sum.unchanged, sum.conflicts, JSON.stringify(sum.details)]);
        if (sum.status === 'failed') await tx.query('update connectors set last_run_at = now() where id=$1', [id]);
        await audit(tx, actor, 'sync', 'connector', id, null, { trigger, ...sum, details: undefined });
      });
    }
    return sum;
  }

  private async upsert(tx: Tx, conn: ConnectorRow, block: Awaited<ReturnType<typeof loadModel>>['blocks'][number],
    fields: FieldMap[], mode: 'overwrite' | 'fill_empty', item: { externalId: string; data: Record<string, unknown> },
    sum: RunSummary, note: (d: Record<string, unknown>) => void) {
    const incoming: Record<string, unknown> = {};
    // A mapping may point at an attribute the entity later switched off: skip it rather than fail the item.
    const activeKeys = new Set(block.attributes.filter((a) => a.active).map((a) => a.key));
    for (const f of fields) {
      if (!activeKeys.has(f.to)) continue;
      const v = applyTransform(pick(item.data, f.from), f.transform);
      if (v !== undefined && v !== null && v !== '') incoming[f.to] = v;
    }
    const title = block.title_key ? String(incoming[block.title_key] ?? '') : '';
    await tx.query('savepoint item');
    try {
      let rec = (await tx.query(
        `select r.* from record_sources s join records r on r.id = s.record_id where s.connector_id=$1 and s.external_id=$2`, [conn.id, item.externalId])).rows[0];
      if (!rec && title) {
        rec = (await tx.query(
          `select r.* from records r where r.block_code=$1 and lower(r.name)=lower($2) and r.status <> 'archived'
             and not exists (select 1 from record_sources s where s.record_id = r.id and s.connector_id = $3) limit 1`, [block.code, title, conn.id])).rows[0];
      }
      const status = conn.auto_approve ? 'approved' : 'draft';
      if (!rec) {
        const { attrs, errors } = validateAttrs(block, incoming);
        if (errors.length) throw Object.assign(new Error('validation'), { errors });
        const created = (await tx.query(
          `insert into records (tenant_id, block_code, name, attrs, status, source) values (app_tenant(),$1,$2,$3,$4,'integration') returning *`,
          [block.code, String(attrs[block.title_key ?? ''] ?? title), JSON.stringify(attrs), status])).rows[0];
        await tx.query(`insert into record_sources (tenant_id, record_id, connector_id, external_id) values (app_tenant(),$1,$2,$3)`, [created.id, conn.id, item.externalId]);
        await audit(tx, { userId: null, tenantId: created.tenant_id, platform: false }, 'sync.create', 'record', created.id, null, created);
        sum.created++;
      } else {
        const merged = { ...rec.attrs };
        let changed = false;
        for (const [k, v] of Object.entries(incoming)) {
          const cur = rec.attrs[k];
          const empty = cur === undefined || cur === null || cur === '';
          if (JSON.stringify(cur) === JSON.stringify(v)) continue;
          if (mode === 'overwrite' || empty) { merged[k] = v; changed = true; }
          else { sum.conflicts++; note({ kind: 'conflict', record_id: rec.id, name: rec.name, attribute: k, repository: cur, source: v }); }
        }
        await tx.query(`insert into record_sources (tenant_id, record_id, connector_id, external_id) values (app_tenant(),$1,$2,$3)
                        on conflict (connector_id, external_id) do update set last_seen_at = now(), record_id = excluded.record_id`, [rec.id, conn.id, item.externalId]);
        if (!changed) { sum.unchanged++; await tx.query('release savepoint item'); return; }
        const { attrs, errors } = validateAttrs(block, merged);
        if (errors.length) throw Object.assign(new Error('validation'), { errors });
        const after = (await tx.query(
          `update records set attrs=$2, name=$3, version=version+1, status=$4, updated_by=null, updated_at=now() where id=$1 returning *`,
          [rec.id, JSON.stringify(attrs), String(attrs[block.title_key ?? ''] ?? rec.name), conn.auto_approve ? rec.status === 'archived' ? 'archived' : 'approved' : 'draft'])).rows[0];
        await audit(tx, { userId: null, tenantId: rec.tenant_id, platform: false }, 'sync.update', 'record', rec.id, rec, after);
        sum.updated++;
      }
      await tx.query('release savepoint item');
    } catch (e) {
      await tx.query('rollback to savepoint item');
      note({ kind: 'error', external_id: item.externalId, name: title, message: (e as Error).message === 'validation' ? undefined : (e as Error).message, errors: (e as { errors?: unknown }).errors });
    }
  }
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private svc: IntegrationsService) {}

  @Perm('integrations.manage')
  @Get('types')
  types() {
    return Object.values(CONNECTOR_TYPES).map((t) => ({
      type: t.type, name_ar: t.name_ar, name_en: t.name_en, description_ar: t.description_ar, description_en: t.description_en,
      settings: t.settings, entities: t.entities({}),
    }));
  }

  @Perm('integrations.manage')
  @Get()
  list(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select c.*, (select row_to_json(r) from (select id, status, trigger, created, updated, unchanged, conflicts, started_at, finished_at
                    from connector_runs where connector_id = c.id order by started_at desc limit 1) r) as last_run
         from connectors c order by c.created_at`)).rows.map(view));
  }

  @Perm('integrations.manage')
  @Post()
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const d = CreateDto.parse(body);
    const ct = typeOf(d.type);
    for (const s of ct.settings.filter((x) => x.required)) {
      if (!(s.secret ? d.secret[s.key] : d.settings[s.key])) throw new BadRequestException({ message: 'حقول ناقصة', errors: [{ key: s.key, message: 'حقل إلزامي' }] });
    }
    const targets = d.targets ?? ct.entities(d.settings).map((e) => ({ entity: e.key, block: e.defaultBlock, enabled: true, mode: 'overwrite' as const, fields: e.defaultMap }));
    return withActor(actorOf(u), async (tx) => {
      const row = (await tx.query(
        `insert into connectors (tenant_id, name, type, config, secret, schedule_minutes, auto_approve, enabled, created_by)
         values (app_tenant(),$1,$2,$3,$4,$5,$6,$7,app_user()) returning *`,
        [d.name, d.type, JSON.stringify({ settings: d.settings, targets }), seal(d.secret), d.schedule_minutes, d.auto_approve, d.enabled])).rows[0];
      await audit(tx, actorOf(u), 'create', 'connector', row.id, null, view(row));
      return view(row);
    });
  }

  @Perm('integrations.manage')
  @Patch(':id')
  update(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const p = PatchDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      const cur = await this.svc.get(tx, id);
      const cfg = { settings: p.settings ?? cur.config.settings, targets: p.targets ?? cur.config.targets };
      // Blank secret fields keep the stored value, so the form never needs to show secrets back.
      const secret = p.secret ? seal({ ...unseal(cur.secret), ...Object.fromEntries(Object.entries(p.secret).filter(([, v]) => v !== '')) }) : cur.secret;
      const row = (await tx.query(
        `update connectors set name=coalesce($2,name), config=$3, secret=$4, schedule_minutes=$5, auto_approve=coalesce($6,auto_approve), enabled=coalesce($7,enabled)
          where id=$1 returning *`,
        [id, p.name ?? null, JSON.stringify(cfg), secret, p.schedule_minutes === undefined ? cur.schedule_minutes : p.schedule_minutes, p.auto_approve ?? null, p.enabled ?? null])).rows[0];
      await audit(tx, actorOf(u), 'update', 'connector', id, view(cur as never), view(row));
      return view(row);
    });
  }

  @Perm('integrations.manage')
  @Delete(':id')
  remove(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const cur = await this.svc.get(tx, id);
      await tx.query('delete from connectors where id=$1', [id]);
      await audit(tx, actorOf(u), 'delete', 'connector', id, view(cur as never), null);
      return { ok: true };
    });
  }

  @Perm('integrations.manage')
  @Get(':id/entities')
  entities(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const c = await this.svc.get(tx, id);
      return typeOf(c.type).entities(c.config.settings ?? {});
    });
  }

  @Perm('integrations.manage')
  @Post(':id/test')
  async test(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    const c = await withActor(actorOf(u), (tx) => this.svc.get(tx, id));
    try {
      return { ok: true, message: await typeOf(c.type).test(c.config.settings ?? {}, unseal(c.secret)) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  @Perm('integrations.manage')
  @Post(':id/run')
  async run(@CurrentUser() u: SessionUser, @Param('id') id: string, @Query('dryRun') dryRun: string, @Headers('accept-language') al?: string) {
    const sum = await this.svc.sync(actorOf(u), id, dryRun === 'true' ? 'dry_run' : 'manual');
    const lang = langOf(al);
    return { ...sum, details: sum.details.map((d) => trBody(d, lang)) };
  }

  @Perm('integrations.manage')
  @Get(':id/runs')
  runs(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select r.*, u.display_name as started_by_name from connector_runs r left join users u on u.id = r.started_by
        where connector_id=$1 order by started_at desc limit 30`, [id])).rows);
  }
}

/** Runs due connectors every minute. An advisory lock keeps two API instances from syncing the same connector. */
export function startScheduler(svc: IntegrationsService) {
  const tick = async () => {
    const { rows } = await pool.query('select * from due_connectors()').catch(() => ({ rows: [] as { id: string; tenant_id: string }[] }));
    for (const c of rows) {
      const client = await pool.connect();
      try {
        const got = (await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [c.id])).rows[0].ok;
        if (!got) continue;
        try { await svc.sync({ userId: null, tenantId: c.tenant_id, platform: false }, c.id, 'schedule'); }
        finally { await client.query('select pg_advisory_unlock(hashtext($1))', [c.id]); }
      } catch (e) { console.error('scheduled sync failed', c.id, (e as Error).message); }
      finally { client.release(); }
    }
  };
  const timer = setInterval(() => { tick().catch(() => undefined); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
