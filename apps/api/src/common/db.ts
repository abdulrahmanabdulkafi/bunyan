import pg from 'pg';
import { config } from './config.js';

// SQL `date` columns are calendar days: keep them as 'YYYY-MM-DD' strings instead of midnight-UTC timestamps that shift across time zones.
pg.types.setTypeParser(1082, (v: string) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize });

/** Who is acting. Set on every transaction so Postgres row-level security can isolate tenants. */
export interface Actor {
  userId: string | null;
  tenantId: string | null;
  platform: boolean; // R0: platform admin, crosses tenants
}

export type Tx = pg.PoolClient;
type TxHooks = Tx & { afterCommit?: (() => Promise<unknown>)[] };
/** Run `job` after the surrounding transaction commits (dropped on rollback). */
export function afterCommit(tx: Tx, job: () => Promise<unknown>) {
  ((tx as TxHooks).afterCommit ??= []).push(job);
}
let txCounter = 0;
export const txIdOf = (tx: Tx) => (tx as Tx & { txId?: number }).txId ?? 0;

/**
 * Run `fn` in a transaction with the actor's context loaded into session settings
 * (app.tenant_id / app.user_id / app.platform). RLS policies read these settings.
 */
export async function withActor<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Pooled clients are reused: give each transaction its own id so per-transaction caches never go stale.
    (client as Tx & { txId?: number }).txId = ++txCounter;
    await client.query(
      `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.platform', $3, true)`,
      [actor.tenantId ?? '', actor.userId ?? '', actor.platform ? 'on' : 'off'],
    );
    const result = await fn(client);
    await client.query('commit');
    // Side effects (e-mail) run only once the data they describe is committed, and never fail the request.
    for (const job of (client as TxHooks).afterCommit?.splice(0) ?? []) job().catch((e) => console.error('after-commit job failed:', (e as Error).message));
    return result;
  } catch (err) {
    (client as TxHooks).afterCommit = [];
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  tenantId: string | null = actor.tenantId,
) {
  await tx.query(
    `insert into audit_log (tenant_id, user_id, action, entity, entity_id, before, after) values ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, actor.userId, action, entity, entityId, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)],
  );
}
