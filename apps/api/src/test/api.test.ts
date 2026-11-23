/**
 * End-to-end tests against a real PostgreSQL loaded with demo data:
 *   node scripts/db-setup.mjs --demo --reset && npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { createApp } from '../main.js';
import { pool } from '../common/db.js';
import { config } from '../common/config.js';

let base = '';
let app: Awaited<ReturnType<typeof createApp>>;
const PW = process.env.DEMO_PASSWORD ?? 'Bunyan@2026';

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function login(email: string) {
  const r = await api('', 'POST', '/auth/login', { email, password: PW });
  assert.equal(r.status, 201, `login ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

const T: Record<string, string> = {};
before(async () => {
  app = await createApp();
  await app.listen(0);
  base = `${await app.getUrl()}/api`.replace('[::1]', 'localhost');
  for (const [k, e] of Object.entries({ ea: 'ea@a.local', arch: 'architect@a.local', entry: 'entry@a.local', owner: 'tech-owner@a.local', viewer: 'viewer@a.local', eb: 'ea@b.local', admin: 'admin@a.local' })) T[k] = await login(e);
});
after(async () => { await app.close(); await pool.end(); });

describe('authentication', () => {
  it('rejects bad passwords with a generic message', async () => {
    const r = await api('', 'POST', '/auth/login', { email: 'ea@a.local', password: 'wrong' });
    assert.equal(r.status, 401);
  });
  it('rejects requests without a token', async () => {
    assert.equal((await api('', 'GET', '/metamodel')).status, 401);
  });
  it('rejects a forged token', async () => {
    assert.equal((await api('eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IngifQ.x', 'GET', '/metamodel')).status, 401);
  });
});

describe('tenant isolation (row-level security)', () => {
  it('entity B cannot see entity A records through the API', async () => {
    const a = await api(T.ea, 'GET', '/records?block=application');
    const b = await api(T.eb, 'GET', '/records?block=application');
    assert.ok(a.body.total > 0);
    assert.equal(b.body.total, 0);
    const one = a.body.items[0].id;
    assert.equal((await api(T.eb, 'GET', `/records/${one}`)).status, 404);
  });
  it('the database itself hides other tenants even for a raw query', async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    await c.connect();
    const total = Number((await c.query('select count(*) from records')).rows[0].count);
    assert.equal(total, 0, 'no tenant context → no rows');
    const tb = (await c.query(`select id from tenants`)).rows; // also hidden without context
    assert.equal(tb.length, 0);
    await c.end();
  });
  it('cannot write a record into another tenant', async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    await c.connect();
    const me = await api(T.eb, 'GET', '/auth/me');
    const other = await api(T.ea, 'GET', '/auth/me');
    await c.query('begin');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [me.body.tenantId]);
    await assert.rejects(
      c.query(`insert into records (tenant_id, block_code, name) values ($1, 'application', 'injected')`, [other.body.tenantId]),
      /row-level security/,
    );
    await c.query('rollback');
    await c.end();
  });
});

describe('permissions', () => {
  it('scoped data entry (technology) cannot touch applications', async () => {
    assert.equal((await api(T.entry, 'GET', '/records?block=application')).status, 403);
    assert.equal((await api(T.entry, 'POST', '/records', { block: 'application', attrs: { name: 'x' } })).status, 403);
  });
  it('viewer cannot create records', async () => {
    assert.equal((await api(T.viewer, 'POST', '/records', { block: 'server', attrs: { server_name: 'x' } })).status, 403);
  });
  it('data entry does not see cost attributes', async () => {
    const r = await api(T.entry, 'GET', '/records?block=server');
    assert.equal(r.status, 200);
    for (const i of r.body.items) assert.ok(!Object.keys(i.attrs).some((k) => /cost/.test(k)));
  });
  it('only the EA owner edits the meta-model', async () => {
    assert.equal((await api(T.arch, 'PATCH', '/metamodel/blocks/server', { name_ar: 'x' })).status, 403);
  });
});

describe('validation & workflow', () => {
  let id = '';
  it('rejects unknown attributes and missing required fields', async () => {
    const r = await api(T.entry, 'POST', '/records', { block: 'server', attrs: { foo: 1, central_processing_units: 'abc' } });
    assert.equal(r.status, 422);
    const keys = r.body.errors.map((e: { key: string }) => e.key);
    assert.ok(keys.includes('foo') && keys.includes('server_name') && keys.includes('central_processing_units'));
  });
  it('maker → checker → final approval', async () => {
    const c = await api(T.entry, 'POST', '/records', { block: 'server', attrs: { server_name: 'SRV-TEST-01', central_processing_units: '٤' } });
    assert.equal(c.status, 201);
    assert.equal(c.body.attrs.central_processing_units, 4, 'Arabic digits are normalised');
    id = c.body.id;
    assert.equal((await api(T.entry, 'POST', `/records/${id}/approve`, {})).status, 403);
    assert.equal((await api(T.entry, 'POST', `/records/${id}/submit`, {})).body.status, 'submitted');
    assert.equal((await api(T.ea, 'POST', `/records/${id}/approve`, {})).status, 400, 'must be reviewed first');
    assert.equal((await api(T.owner, 'POST', `/records/${id}/reject`, {})).status, 400, 'reject needs a reason');
    assert.equal((await api(T.owner, 'POST', `/records/${id}/review`, {})).body.status, 'reviewed');
    assert.equal((await api(T.ea, 'POST', `/records/${id}/approve`, {})).body.status, 'approved');
  });
  it('editing an approved record returns it to draft, with optimistic locking', async () => {
    const cur = await api(T.entry, 'GET', `/records/${id}`);
    const stale = cur.body.version - 1;
    assert.equal((await api(T.entry, 'PATCH', `/records/${id}`, { attrs: { random_access_memory_ram: 64 }, version: stale })).status, 409);
    const u = await api(T.entry, 'PATCH', `/records/${id}`, { attrs: { random_access_memory_ram: 64 }, version: cur.body.version });
    assert.equal(u.status, 200);
    assert.equal(u.body.status, 'draft');
  });
  it('the editor cannot review their own change', async () => {
    await api(T.ea, 'POST', `/records/${id}/submit`, {});
    const r = await api(T.ea, 'PATCH', `/records/${id}`, { attrs: { disc: 500 }, version: (await api(T.ea, 'GET', `/records/${id}`)).body.version });
    assert.equal(r.status, 200);
    await api(T.ea, 'POST', `/records/${id}/submit`, {});
    assert.equal((await api(T.ea, 'POST', `/records/${id}/review`, {})).status, 403);
  });
  it('every change is in the audit log', async () => {
    const r = await api(T.ea, 'GET', `/approvals/audit?entity_id=${id}`);
    const actions = r.body.map((x: { action: string }) => x.action);
    for (const a of ['create', 'submit', 'review', 'approve', 'update']) assert.ok(actions.includes(a), a);
  });
});

describe('meta-model configuration', () => {
  it('adds a custom attribute with options and enforces it', async () => {
    const add = await api(T.ea, 'POST', '/metamodel/blocks/server/attributes', {
      key: 'hosting_zone', name_ar: 'منطقة الاستضافة', name_en: 'Hosting zone', type: 'enum',
      options: [{ value: 'DMZ' }, { value: 'Internal' }],
    });
    assert.equal(add.status, 201);
    const bad = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z1', hosting_zone: 'Moon' } });
    assert.equal(bad.status, 422);
    const ok = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z1', hosting_zone: 'DMZ' } });
    assert.equal(ok.status, 201);
  });
  it('entity B is not affected by entity A model changes', async () => {
    const m = await api(T.eb, 'GET', '/metamodel');
    const server = m.body.blocks.find((b: { code: string }) => b.code === 'server');
    assert.ok(!server.attributes.some((a: { key: string }) => a.key === 'hosting_zone'));
  });
  it('template attributes are deactivated, not deleted', async () => {
    const d = await api(T.ea, 'DELETE', '/metamodel/blocks/server/attributes/disc');
    assert.equal(d.status, 200);
    assert.equal(d.body.active, false);
  });
});

describe('excel template round trip', () => {
  it('exports a template and imports new rows, all-or-nothing', async () => {
    const res = await fetch(`${base}/io/export?blocks=license`, { headers: { authorization: `Bearer ${T.ea}` } });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.worksheets.find((w) => w.state !== 'veryHidden')!;
    const keys = (ws.getRow(2).values as string[]).slice(1);
    const col = (k: string) => keys.indexOf(k) + 1;
    ws.getCell(3, col('license_name')).value = 'رخصة مستوردة';
    ws.getCell(3, col('quantity')).value = 5;
    ws.getCell(4, col('quantity')).value = 'many'; // invalid row → nothing should be saved
    const upload = async (buf: ArrayBuffer, dry = false) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), 'x.xlsx');
      const r = await fetch(`${base}/io/import${dry ? '?dryRun=true' : ''}`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${T.ea}` } });
      return { status: r.status, body: await r.json() };
    };
    const bad = await upload(await wb.xlsx.writeBuffer() as ArrayBuffer);
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.some((e: { row: number; key: string }) => e.row === 4 && e.key === 'license_name'));
    ws.getCell(4, col('license_name')).value = 'رخصة ثانية';
    ws.getCell(4, col('quantity')).value = 3;
    const ok = await upload(await wb.xlsx.writeBuffer() as ArrayBuffer);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.created, 2);
    const list = await api(T.ea, 'GET', '/records?block=license&q=مستوردة');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].source, 'excel');
  });
});
