/**
 * End-to-end tests against a real PostgreSQL loaded with demo data:
 *   node scripts/db-setup.mjs --demo --reset && npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import ldap from 'ldapjs';
import pg from 'pg';
import { createApp } from '../main.js';
import { pool } from '../common/db.js';
import { config } from '../common/config.js';
import { totp } from '../common/crypto.js';

let base = '';
let app: Awaited<ReturnType<typeof createApp>>;
const PW = process.env.DEMO_PASSWORD ?? 'Bunyan@2026';
process.env.CONNECTOR_ALLOW_LOOPBACK = 'true'; // the mock vCenter below listens on localhost

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
  for (const [k, e] of Object.entries({ platform: 'platform@bunyan.local', national: 'national@bunyan.local', auditor: 'auditor@a.local', ea: 'ea@a.local', arch: 'architect@a.local', entry: 'entry@a.local', owner: 'tech-owner@a.local', viewer: 'viewer@a.local', eb: 'ea@b.local', admin: 'admin@a.local' })) T[k] = await login(e);
});
after(async () => { await app.close(); await pool.end(); });

describe('authentication', () => {
  it('rejects bad passwords with a generic message', async () => {
    const r = await api('', 'POST', '/auth/login', { email: 'ea@a.local', password: 'wrong' });
    assert.equal(r.status, 401);
  });
  it('answers in English when the client asks for it', async () => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'en' }, body: JSON.stringify({ email: 'ea@a.local', password: 'x' }) });
    assert.equal((await res.json()).message, 'Incorrect email or password');
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

describe('relationships', () => {
  it('links two records only through a relation defined in the meta-model', async () => {
    const apps = (await api(T.ea, 'GET', '/records?block=application')).body.items;
    const servers = (await api(T.ea, 'GET', '/records?block=server')).body.items;
    const m = (await api(T.ea, 'GET', '/metamodel')).body;
    const hosts = m.relations.find((r: { source_code: string; verb: string; target_code: string }) => r.source_code === 'server' && r.verb === 'Hosts' && r.target_code === 'application');
    const ok = await api(T.ea, 'POST', `/records/${servers[0].id}/links`, { relation_id: hosts.id, target_id: apps[0].id });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const wrong = await api(T.ea, 'POST', `/records/${apps[0].id}/links`, { relation_id: hosts.id, target_id: servers[0].id });
    assert.equal(wrong.status, 400);
    const detail = await api(T.ea, 'GET', `/records/${apps[0].id}`);
    assert.ok(detail.body.links.some((l: { direction: string; other_id: string }) => l.direction === 'in' && l.other_id === servers[0].id));
  });
});

describe('meta-model configuration', () => {
  it('predefined lists accept any value by default, and only strict lists reject others', async () => {
    const add = await api(T.ea, 'POST', '/metamodel/blocks/server/attributes', {
      key: 'hosting_zone', name_ar: 'منطقة الاستضافة', name_en: 'Hosting zone', type: 'enum',
      options: [{ value: 'DMZ' }, { value: 'Internal' }],
    });
    assert.equal(add.status, 201);
    const open = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z0', hosting_zone: 'Partner zone' } });
    assert.equal(open.status, 201, 'open list accepts a value outside the suggestions');
    assert.equal((await api(T.ea, 'PATCH', '/metamodel/blocks/server/attributes/hosting_zone', { strict: true })).status, 200);
    const bad = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z1', hosting_zone: 'Moon' } });
    assert.equal(bad.status, 422);
    const ok = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z1', hosting_zone: 'DMZ' } });
    assert.equal(ok.status, 201);
  });
  it('an attribute can hold a list of values', async () => {
    assert.equal((await api(T.ea, 'PATCH', '/metamodel/blocks/server/attributes/environment', { multiple: true })).status, 200);
    const r = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z2', environment: 'الإنتاج; الاختبار' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.attrs.environment, ['الإنتاج', 'الاختبار']);
    const r2 = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'Z3', environment: ['التطوير'] } });
    assert.deepEqual(r2.body.attrs.environment, ['التطوير']);
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

describe('national meta-model (DGA EA Content Meta Model)', () => {
  it('has every domain, building block, attribute and connection of the guide, all active', async () => {
    const m = (await api(T.ea, 'GET', '/metamodel')).body;
    assert.equal(m.domains.length, 7);
    assert.ok(m.domains.every((d: { active: boolean }) => d.active));
    const national = m.blocks.filter((b: { is_custom: boolean }) => !b.is_custom);
    assert.equal(national.length, 45);
    assert.ok(national.every((b: { active: boolean }) => b.active));
    assert.equal(national.reduce((a: number, b: { attributes: { is_custom: boolean }[] }) => a + b.attributes.filter((x) => !x.is_custom).length, 0), 375);
    assert.equal(m.relations.length, 312);
    const has = (s: string, v: string, t: string) => m.relations.some((r: { source_code: string; verb: string; target_code: string }) => r.source_code === s && r.verb === v && r.target_code === t);
    assert.ok(has('persona', 'Owns', 'beneficiary_journey') && has('service', 'Automated', 'application') && !has('beneficiary', 'Owns', 'beneficiary_journey'));
    const env = m.blocks.find((b: { code: string }) => b.code === 'server').attributes.find((a: { key: string }) => a.key === 'environment');
    assert.ok(env.options.some((o: { label_ar: string }) => o.label_ar === 'بيئة الإنتاج'));
  });

  it('stores an Arabic or English list label as the list value', async () => {
    const a = await api(T.ea, 'POST', '/records', { block: 'objective', attrs: { name: 'هدف تجريبي' } });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const s = await api(T.ea, 'POST', '/records', { block: 'server', attrs: { server_name: 'SRV-LBL-1', environment: 'بيئة الإنتاج', status: 'operational' } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.deepEqual([s.body.attrs.environment].flat(), ['Production environment']); // the demo entity made this list multi-value
    assert.equal(s.body.attrs.status, 'Operational');
  });
});

describe('viewpoints', () => {
  it('lists the 35 viewpoints, all available now that every domain is active', async () => {
    const r = await api(T.ea, 'GET', '/viewpoints/catalog');
    assert.equal(r.body.length, 35);
    const byDomain = (d: string) => r.body.filter((v: { domain: string }) => v.domain === d).length;
    assert.deepEqual([byDomain('applications'), byDomain('technology'), byDomain('security')], [15, 12, 8]);
    assert.equal(r.body.filter((v: { missing: string[] }) => v.missing.length === 0).length, 35);
  });
  it('builds every available viewpoint without error', async () => {
    const cat = (await api(T.ea, 'GET', '/viewpoints/catalog')).body;
    for (const v of cat) {
      const r = await api(T.ea, 'GET', `/viewpoints/run/${v.code}`);
      assert.equal(r.status, 200, v.code);
      if (!v.missing.length) assert.equal(r.body.kind, v.kind, v.code);
    }
  });
  it('matrix follows intermediate blocks (data center → host → server → application)', async () => {
    const r = await api(T.ea, 'GET', '/viewpoints/run/TEC-M2');
    const dc = r.body.rows.find((x: { name: string }) => x.name.includes('الرياض'));
    const crm = r.body.cols.find((x: { name: string }) => x.name === 'نظام إدارة علاقات العملاء');
    assert.ok(r.body.cells.some((c: { row: string; col: string }) => c.row === dc.id && c.col === crm.id));
  });
  it('application integration view links applications through their interfaces', async () => {
    const r = await api(T.ea, 'GET', '/viewpoints/run/APP-D4');
    assert.ok(r.body.nodes.every((n: { block_code: string }) => n.block_code === 'application'));
    assert.ok(r.body.edges.length >= 2);
  });
  it('detail levels change the columns of a catalogue', async () => {
    const c = await api(T.ea, 'GET', '/viewpoints/run/APP-L1?level=conceptual');
    const p = await api(T.ea, 'GET', '/viewpoints/run/APP-L1?level=physical');
    assert.equal(c.body.columns.length, 1);
    assert.ok(p.body.columns.length > 10);
  });
  it('hides cost columns from users without cost permission', async () => {
    const r = await api(T.entry, 'GET', '/viewpoints/run/TEC-L1?level=physical');
    assert.ok(!r.body.columns.some((c: { key: string }) => /cost/.test(c.key)));
  });
});

describe('integrations (vCenter)', () => {
  let vc: http.Server;
  let url = '';
  const state = { cpu: 8, password: 'vc-secret-1' };
  before(async () => {
    vc = http.createServer((req, res) => {
      const send = (b: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/api/session' && req.method === 'POST') {
        const ok = req.headers.authorization === `Basic ${Buffer.from(`svc-ea@vsphere.local:${state.password}`).toString('base64')}`;
        return ok ? send('tok-123', 201) : send({ error: 'unauthenticated' }, 401);
      }
      if (req.url === '/api/session' && req.method === 'DELETE') return send(null, 204);
      if (req.headers['vmware-api-session-id'] !== 'tok-123') return send({}, 401);
      if (req.method !== 'GET') return send({}, 405); // read-only: the connector must never write
      if (req.url === '/api/vcenter/cluster') return send([{ cluster: 'domain-c1', name: 'CL-PROD' }]);
      if (req.url === '/api/vcenter/host?clusters=domain-c1') return send([{ host: 'host-1' }]);
      if (req.url === '/api/vcenter/host') return send([
        { host: 'host-1', name: 'ESX-RUH-01', connection_state: 'CONNECTED', power_state: 'POWERED_ON' },
        { host: 'host-9', name: 'esx-new-09', connection_state: 'CONNECTED', power_state: 'POWERED_ON' },
      ]);
      if (req.url === '/api/vcenter/vm') return send([{ vm: 'vm-1', name: 'SRV-CRM-01', power_state: 'POWERED_ON' }, { vm: 'vm-7', name: 'SRV-NEW-07', power_state: 'POWERED_OFF' }]);
      if (req.url === '/api/vcenter/vm/vm-1') return send({ guest_OS: 'RHEL_9_64', cpu: { count: state.cpu }, memory: { size_MiB: 65536 }, disks: { '2000': { capacity: 107374182400 } }, placement: { host: 'host-1' } });
      if (req.url === '/api/vcenter/vm/vm-7') return send({ guest_OS: 'WINDOWS_SERVER_2022', cpu: { count: 2 }, memory: { size_MiB: 8192 }, disks: {}, placement: { host: 'host-9' } });
      send({}, 404);
    });
    await new Promise<void>((r) => vc.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(vc.address() as AddressInfo).port}`;
  });
  after(() => { vc.close(); });

  let id = '';
  it('only entity admins and EA owners manage connectors', async () => {
    assert.equal((await api(T.arch, 'GET', '/integrations')).status, 403);
  });
  it('stores credentials encrypted and never returns them', async () => {
    const r = await api(T.ea, 'POST', '/integrations', {
      name: 'vCenter الرياض', type: 'vcenter', settings: { url }, secret: { username: 'svc-ea@vsphere.local', password: state.password },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.id;
    assert.equal(r.body.secret, undefined);
    assert.equal(r.body.has_secret, true);
    const c = new pg.Client({ connectionString: config.databaseUrl.replace('bunyan_app:bunyan_app', 'bunyan_owner:bunyan_owner') });
    await c.connect();
    await c.query(`select set_config('app.platform','on',false)`);
    const raw = (await c.query('select secret from connectors where id=$1', [id])).rows[0].secret as string;
    await c.end();
    assert.ok(raw.startsWith('v1.') && !raw.includes(state.password));
  });
  it('tests the connection', async () => {
    assert.equal((await api(T.ea, 'POST', `/integrations/${id}/test`)).body.ok, true);
    state.password = 'rotated';
    const bad = await api(T.ea, 'POST', `/integrations/${id}/test`);
    assert.equal(bad.body.ok, false);
    await api(T.ea, 'PATCH', `/integrations/${id}`, { secret: { password: 'rotated', username: '' } });
    assert.equal((await api(T.ea, 'POST', `/integrations/${id}/test`)).body.ok, true, 'blank username keeps the stored one');
  });
  it('a dry run reports changes without saving them', async () => {
    const before = (await api(T.ea, 'GET', '/records?block=server')).body.total;
    const r = await api(T.ea, 'POST', `/integrations/${id}/run?dryRun=true`);
    assert.equal(r.body.status, 'succeeded', JSON.stringify(r.body.details));
    assert.equal(r.body.created, 2, JSON.stringify(r.body)); // esx-new-09, SRV-NEW-07
    assert.equal(r.body.updated, 1); // SRV-CRM-01 matched by name and changed
    assert.equal(r.body.unchanged, 1); // ESX-RUH-01 matched by name, same values
    assert.equal(r.body.details.length, 0, 'the disc mapping targets an attribute switched off earlier and is skipped');
    assert.equal((await api(T.ea, 'GET', '/records?block=server')).body.total, before);
  });
  it('syncs: merges by name, creates drafts, then matches by source id', async () => {
    const r = await api(T.ea, 'POST', `/integrations/${id}/run`);
    assert.equal(r.body.status, 'succeeded');
    const crm = (await api(T.ea, 'GET', '/records?block=server&q=SRV-CRM-01')).body.items[0];
    assert.equal(crm.attrs.central_processing_units, 8);
    assert.equal(crm.attrs.random_access_memory_ram, 64);
    assert.equal(crm.status, 'draft', 'changed data goes back through approval');
    const fresh = (await api(T.ea, 'GET', '/records?block=server&q=SRV-NEW-07')).body.items[0];
    assert.equal(fresh.source, 'integration');
    assert.equal(fresh.status, 'draft');
    const again = await api(T.ea, 'POST', `/integrations/${id}/run`);
    assert.deepEqual([again.body.created, again.body.updated, again.body.unchanged], [0, 0, 4]);
    const runs = await api(T.ea, 'GET', `/integrations/${id}/runs`);
    assert.equal(runs.body.length, 2);
  });
  it('fill-empty mode keeps repository values and reports conflicts', async () => {
    const conn = (await api(T.ea, 'GET', '/integrations')).body.find((c: { id: string }) => c.id === id);
    const targets = conn.config.targets.map((t: { entity: string }) => ({ ...t, mode: t.entity === 'vm' ? 'fill_empty' : 'overwrite' }));
    await api(T.ea, 'PATCH', `/integrations/${id}`, { targets });
    state.cpu = 12;
    const r = await api(T.ea, 'POST', `/integrations/${id}/run`);
    assert.equal(r.body.conflicts, 1);
    assert.equal(r.body.details[0].attribute, 'central_processing_units');
    const crm = (await api(T.ea, 'GET', '/records?block=server&q=SRV-CRM-01')).body.items[0];
    assert.equal(crm.attrs.central_processing_units, 8);
  });
  it('refuses cloud-metadata and link-local addresses', async () => {
    const r = await api(T.ea, 'POST', '/integrations', { name: 'bad', type: 'json_api', settings: { url: 'http://169.254.169.254/latest/meta-data', id_field: 'id', source_fields: 'id' }, secret: {} });
    const t = await api(T.ea, 'POST', `/integrations/${r.body.id}/test`);
    assert.equal(t.body.ok, false);
    assert.match(t.body.message, /blocked/);
  });
  it('entity B cannot see entity A connectors', async () => {
    assert.equal((await api(T.eb, 'GET', '/integrations')).body.length, 0);
    assert.equal((await api(T.eb, 'POST', `/integrations/${id}/run`)).status, 404);
  });
});

describe('compliance (NCA ECC)', () => {
  let ecc = '';
  it('ships the NCA libraries with the totals their documents state', async () => {
    const list = (await api(T.ea, 'GET', '/compliance/frameworks')).body;
    const f = list.find((x: { code: string }) => x.code === 'ECC');
    ecc = f.id;
    assert.equal(f.version, '2:2024');
    assert.equal(f.enabled, true);
    const count = async (code: string) => {
      const fw = list.find((x: { code: string }) => x.code === code);
      const tree = (await api(T.ea, 'GET', `/compliance/frameworks/${fw.id}/tree`)).body;
      return ['domain', 'subdomain', 'control', 'subcontrol'].map((l) => tree.filter((i: { level: string }) => i.level === l).length);
    };
    assert.deepEqual(await count('ECC'), [4, 28, 108, 92]);
    assert.deepEqual(await count('OTCC'), [4, 23, 47, 122]);
    assert.deepEqual(await count('DCC'), [3, 11, 19, 47]);
    assert.deepEqual(await count('TCC'), [3, 16, 21, 42]);
    assert.deepEqual(await count('CSCC'), [4, 21, 33, 73]);
    assert.deepEqual(await count('CCC'), [4, 24, 0, 0]);
    const item = (await api(T.ea, 'GET', `/compliance/frameworks/${ecc}/tree`)).body.find((i: { code: string }) => i.code === '2-15-3-1');
    const detail = (await api(T.ea, 'GET', `/compliance/items/${item.id}`)).body;
    assert.match(detail.item.text_ar, /جدار الحماية لتطبيقات الويب/);
  });
  it('summarises coverage, status and unprotected assets', async () => {
    const s = (await api(T.ea, 'GET', '/compliance/summary')).body;
    const f = s.frameworks[0];
    assert.equal(f.total, 176, 'assessable items are subcontrols plus controls without subcontrols');
    assert.equal(f.covered, 3);
    assert.equal(f.counts.compliant, 3);
    assert.equal(f.counts.partial, 1);
    assert.equal(f.counts.non_compliant, 1);
    assert.ok(s.unprotected.some((x: { name: string }) => x.name === 'SRV-DMS-01'));
    assert.ok(!s.unprotected.some((x: { name: string }) => x.name === 'نظام إدارة علاقات العملاء'), 'the firewall secures it');
  });
  it('maps an asset, records evidence, and shows it on the record', async () => {
    const tree = (await api(T.ea, 'GET', `/compliance/frameworks/${ecc}/tree`)).body;
    const backup = tree.find((i: { code: string }) => i.code === '2-9-3-1');
    const srv = (await api(T.ea, 'GET', '/records?block=server&q=SRV-ERP-01')).body.items[0];
    const r = await api(T.arch, 'PUT', `/compliance/items/${backup.id}/assessment`, { record_id: srv.id, status: 'partial', evidence: 'نسخ يومي دون اختبار استعادة' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const forRec = (await api(T.ea, 'GET', `/compliance/records/${srv.id}`)).body;
    assert.ok(forRec.some((x: { code: string; status: string }) => x.code === '2-9-3-1' && x.status === 'partial'));
    const again = await api(T.arch, 'PUT', `/compliance/items/${backup.id}/assessment`, { record_id: srv.id, status: 'compliant' });
    assert.equal(again.body.id, r.body.id, 'one assessment per control and asset');
  });
  it('respects roles: auditor reads, cannot assess; scoped owner only within scope; viewer of library cannot edit it', async () => {
    const tree = (await api(T.ea, 'GET', `/compliance/frameworks/${ecc}/tree`)).body;
    const it2 = tree.find((i: { code: string }) => i.code === '2-2-3-1');
    assert.equal((await api(T.auditor, 'GET', '/compliance/summary')).status, 200);
    assert.equal((await api(T.auditor, 'PUT', `/compliance/items/${it2.id}/assessment`, { status: 'compliant' })).status, 403);
    const app = (await api(T.ea, 'GET', '/records?block=application')).body.items[0];
    assert.equal((await api(T.owner, 'PUT', `/compliance/items/${it2.id}/assessment`, { record_id: app.id, status: 'compliant' })).status, 403, 'technology owner cannot map an application');
    assert.equal((await api(T.owner, 'PUT', `/compliance/items/${it2.id}/assessment`, { status: 'compliant' })).status, 403, 'entity-level status is for the EA owner or architect');
    assert.equal((await api(T.ea, 'POST', '/compliance/frameworks', { code: 'X', version: '1', name_ar: 'س', name_en: 'x' })).status, 403);
  });
  it('platform admin loads control texts from Excel; new controls become assessable items', async () => {
    const ccc = (await api(T.platform, 'GET', '/compliance/frameworks')).body.find((x: { code: string }) => x.code === 'CCC');
    await api(T.ea, 'PUT', `/compliance/frameworks/${ccc.id}/enabled`, { enabled: true });
    const res = await fetch(`${base}/compliance/frameworks/${ccc.id}/template`, { headers: { authorization: `Bearer ${T.platform}` } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.worksheets[0];
    assert.equal(ws.rowCount, 29);
    ws.addRow(['2-15-P-1', 'control', '2-15', 'ضابط تجريبي للاختبار', 'Test control', '', '']);
    ws.addRow(['2-15-P-2', 'control', '2-15', 'ضابط تجريبي ثانٍ', 'Second test control', '', '']);
    const fd = new FormData();
    fd.append('file', new Blob([await wb.xlsx.writeBuffer() as ArrayBuffer]), 'x.xlsx');
    const imp = await fetch(`${base}/compliance/frameworks/${ccc.id}/import`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${T.platform}` } });
    const body = await imp.json();
    assert.equal(imp.status, 201, JSON.stringify(body));
    assert.equal(body.created, 2);
    const s = (await api(T.ea, 'GET', '/compliance/summary')).body;
    assert.equal(s.frameworks.find((f: { code: string }) => f.code === 'CCC').total, 25, '23 subdomain leaves + 2 controls');
  });
  it('compliance report exports', async () => {
    const res = await fetch(`${base}/compliance/report.xlsx`, { headers: { authorization: `Bearer ${T.ea}` } });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    assert.equal(wb.worksheets.length, 3, 'summary + ECC + CCC');
  });
  it('national dashboard shows coverage as an aggregate only', async () => {
    const n = (await api(T.national, 'GET', '/viewpoints/national')).body;
    const a = n.entities.find((e: { tenant: string }) => e.tenant.includes('(أ)'));
    assert.ok(a.coverage > 0 && a.coverage < 1);
    assert.equal((await api(T.national, 'GET', '/compliance/summary')).status, 403);
  });
});

describe('integrations (Active Directory)', () => {
  let server: ldap.Server;
  let url = '';
  const BIND = 'cn=svc-bunyan,dc=demo,dc=local';
  const computers = [
    { dn: 'cn=SRV-ERP-01,ou=servers,dc=demo,dc=local', attributes: { cn: 'SRV-ERP-01', objectGUID: 'guid-erp', operatingSystem: 'Windows Server 2022 Datacenter', operatingSystemVersion: '10.0 (20348)', objectCategory: 'computer' } },
    { dn: 'cn=srv-hr-02,ou=servers,dc=demo,dc=local', attributes: { cn: 'srv-hr-02', objectGUID: 'guid-hr', operatingSystem: 'Windows Server 2019 Standard', operatingSystemVersion: '10.0 (17763)', objectCategory: 'computer' } },
    { dn: 'cn=LAPTOP-7,ou=workstations,dc=demo,dc=local', attributes: { cn: 'LAPTOP-7', objectGUID: 'guid-lt', operatingSystem: 'Windows 11 Enterprise', objectCategory: 'computer' } },
  ];
  before(async () => {
    server = ldap.createServer();
    server.bind('dc=demo,dc=local', (req: any, res: any, next: any) => {
      if (req.dn.toString() === BIND && req.credentials === 'ad-secret') { res.end(); return next(); }
      return next(new ldap.InvalidCredentialsError());
    });
    server.search('dc=demo,dc=local', (req: any, res: any, next: any) => {
      // ldapjs only echoes requested attributes whose names match in lower case — which also exercises
      // the connector's case-insensitive attribute handling.
      const lower = (a: object) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k.toLowerCase(), v]));
      for (const c of computers) if (c.dn.endsWith(req.dn.toString()) && req.filter.matches(c.attributes)) res.send({ dn: c.dn, attributes: lower(c.attributes) });
      res.end(); next();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `ldap://127.0.0.1:${((server as any).server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(() => undefined); });

  it('reads server computers only, merges by name, and creates the rest', async () => {
    const c = await api(T.ea, 'POST', '/integrations', {
      name: 'AD', type: 'active_directory', settings: { url, base_dn: 'dc=demo,dc=local' }, secret: { bind_dn: BIND, password: 'ad-secret' },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await api(T.ea, 'POST', `/integrations/${c.body.id}/test`)).body.ok, true);
    const r = await api(T.ea, 'POST', `/integrations/${c.body.id}/run`);
    assert.equal(r.body.status, 'succeeded', JSON.stringify(r.body.details));
    assert.deepEqual([r.body.created, r.body.updated], [1, 1], 'the workstation is filtered out');
    const hr = (await api(T.ea, 'GET', '/records?block=server&q=SRV-HR-02')).body.items[0];
    assert.equal(hr.name, 'SRV-HR-02', 'name upper-cased by the default mapping');
    assert.equal(hr.attrs.operating_system_type, 'Windows Server 2019 Standard');
    const erp = (await api(T.ea, 'GET', '/records?block=server&q=SRV-ERP-01')).body.items[0];
    assert.equal(erp.attrs.operating_system_version, '10.0 (20348)');
  });
  it('reports wrong credentials without changing anything', async () => {
    const c = await api(T.ea, 'POST', '/integrations', { name: 'AD bad', type: 'active_directory', settings: { url, base_dn: 'dc=demo,dc=local' }, secret: { bind_dn: BIND, password: 'nope' } });
    const r = await api(T.ea, 'POST', `/integrations/${c.body.id}/run`);
    assert.equal(r.body.status, 'failed');
    assert.equal(r.body.created + r.body.updated, 0);
  });
});

describe('account security (NCA ECC 2-2)', () => {
  const strong = 'Sahm-Qawi#2026x';
  let tmpUser = { id: '', email: 'new.user@a.local', temp: '' };
  it('enforces the password policy and a one-time password for new accounts', async () => {
    const weak = await api(T.admin, 'POST', '/users', { email: 'weak@a.local', display_name: 'ضعيف', password: 'abc12345', roles: ['R6'] });
    assert.equal(weak.status, 400);
    const r = await api(T.admin, 'POST', '/users', { email: tmpUser.email, display_name: 'مستخدم جديد', roles: ['R6'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.temporary_password);
    tmpUser = { id: r.body.id, email: tmpUser.email, temp: r.body.temporary_password };
  });
  it('a first sign-in must change the password before doing anything else', async () => {
    const l = await api('', 'POST', '/auth/login', { email: tmpUser.email, password: tmpUser.temp });
    assert.equal(l.body.limited, 'password_change');
    assert.equal((await api(l.body.token, 'GET', '/records?block=application')).status, 403);
    assert.equal((await api(l.body.token, 'POST', '/auth/password', { current: tmpUser.temp, next: 'short' })).status, 400);
    const c = await api(l.body.token, 'POST', '/auth/password', { current: tmpUser.temp, next: strong });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.limited, null);
    assert.equal((await api(c.body.token, 'GET', '/records?block=application')).status, 200);
    assert.equal((await api(l.body.token, 'GET', '/auth/me')).status, 401, 'the old session ends after a password change');
  });
  it('locks the account after repeated failures; the admin can unlock it', async () => {
    for (let i = 0; i < 5; i++) await api('', 'POST', '/auth/login', { email: tmpUser.email, password: 'Wrong-Password-1' });
    const locked = await api('', 'POST', '/auth/login', { email: tmpUser.email, password: strong });
    assert.equal(locked.status, 423);
    assert.equal((await api(T.admin, 'POST', `/users/${tmpUser.id}/unlock`)).status, 201);
    assert.equal((await api('', 'POST', '/auth/login', { email: tmpUser.email, password: strong })).status, 201);
  });
  it('two-step verification with an authenticator app', async () => {
    const t = (await api('', 'POST', '/auth/login', { email: tmpUser.email, password: strong })).body.token;
    const setup = await api(t, 'POST', '/auth/mfa/setup');
    assert.match(setup.body.otpauth, /^otpauth:\/\/totp\//);
    assert.equal((await api(t, 'POST', '/auth/mfa/enable', { code: '000000' })).status, 400);
    const en = await api(t, 'POST', '/auth/mfa/enable', { code: totp(setup.body.secret) });
    assert.equal(en.status, 201, JSON.stringify(en.body));
    const step1 = await api('', 'POST', '/auth/login', { email: tmpUser.email, password: strong });
    assert.equal(step1.body.mfa_required, true);
    assert.equal(step1.body.token, undefined, 'no session before the second factor');
    assert.equal((await api(step1.body.challenge, 'GET', '/auth/me')).status, 401, 'a challenge is not a session');
    assert.equal((await api('', 'POST', '/auth/mfa/verify', { challenge: step1.body.challenge, code: '123456' })).status, 401);
    const ok = await api('', 'POST', '/auth/mfa/verify', { challenge: step1.body.challenge, code: totp(setup.body.secret) });
    assert.equal(ok.status, 201);
    assert.equal((await api(ok.body.token, 'GET', '/auth/me')).body.mfaEnabled, true);
  });
  it('privileged roles must enrol in two-step verification', async () => {
    process.env.MFA_REQUIRED_ROLES = 'R2';
    try {
      const l = await api('', 'POST', '/auth/login', { email: 'ea@b.local', password: PW });
      assert.equal(l.body.limited, 'mfa_setup');
      assert.equal((await api(l.body.token, 'GET', '/metamodel')).status, 403);
      assert.equal((await api(l.body.token, 'POST', '/auth/mfa/setup')).status, 201);
    } finally { process.env.MFA_REQUIRED_ROLES = 'none'; }
  });
  it('disabling an account ends its sessions immediately', async () => {
    const r = await api(T.admin, 'POST', '/users', { email: 'temp2@a.local', display_name: 'مؤقت', roles: ['R6'], password: 'Another-Strong#2026' });
    const l = await api('', 'POST', '/auth/login', { email: 'temp2@a.local', password: 'Another-Strong#2026' });
    const c = await api(l.body.token, 'POST', '/auth/password', { current: 'Another-Strong#2026', next: strong + 'y' });
    assert.equal((await api(c.body.token, 'GET', '/auth/me')).status, 200);
    await api(T.admin, 'PATCH', `/users/${r.body.id}`, { active: false });
    assert.equal((await api(c.body.token, 'GET', '/auth/me')).status, 401);
  });
  it('an admin cannot disable their own account; sessions can be renewed', async () => {
    const me = (await api(T.admin, 'GET', '/auth/me')).body;
    assert.equal((await api(T.admin, 'PATCH', `/users/${me.id}`, { active: false })).status, 400);
    const r = await api(T.admin, 'POST', '/auth/refresh');
    assert.equal(r.status, 201);
    assert.ok(r.body.token);
  });
  it('sends hardening headers', async () => {
    const res = await fetch(`${base}/auth/policy`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('import wizard (any spreadsheet)', () => {
  const wizard = async (path: string, wb: ExcelJS.Workbook, fields: Record<string, string>) => {
    const fd = new FormData();
    fd.append('file', new Blob([await wb.xlsx.writeBuffer() as ArrayBuffer]), 'inventory.xlsx');
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const r = await fetch(`${base}/io/wizard/${path}`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${T.ea}` } });
    return { status: r.status, body: await r.json() };
  };
  // An entity's own file: a title block above the table, Arabic headers, units inside numbers, a list of hosts per cell.
  const book = () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('حصر الخوادم');
    ws.addRow(['حصر الأصول التقنية — 2026']);
    ws.addRow([]);
    ws.addRow(['اسم الخادم', 'الذاكرة', 'المعالجات', 'التطبيقات المستضافة']);
    ws.addRow(['SRV-WZ-01', '16 GB', 8, 'تطبيق المعالج أ؛ تطبيق المعالج ب']);
    ws.addRow(['SRV-WZ-02', '٣٢ GB', 'أربعة', '']);
    ws.addRow(['SRV-WZ-01', '16 GB', 8, '']);
    return wb;
  };

  it('finds the header row, maps columns, validates in a dry run, imports, links, and re-imports without duplicates', async () => {
    const ins = await wizard('inspect', book(), {});
    assert.equal(ins.status, 201, JSON.stringify(ins.body));
    assert.equal(ins.body.header_row, 3);
    assert.deepEqual(ins.body.columns.map((c: { header: string }) => c.header), ['اسم الخادم', 'الذاكرة', 'المعالجات', 'التطبيقات المستضافة']);

    const model = (await api(T.ea, 'GET', '/metamodel')).body;
    const hosts = model.relations.find((r: { source_code: string; target_code: string }) => r.source_code === 'server' && r.target_code === 'application');
    const mapping = (extra: object) => JSON.stringify({
      sheet: 'حصر الخوادم', header_row: 3, block: 'server',
      columns: { 1: 'server_name', 2: 'random_access_memory_ram', 3: 'central_processing_units', 4: `rel:${hosts.id}` },
      create_missing_links: true, ...extra,
    });
    const dry = await wizard('run', book(), { mapping: mapping({ dry_run: true }) });
    assert.equal(dry.status, 201, JSON.stringify(dry.body));
    assert.equal(dry.body.saved, false);
    assert.equal(dry.body.errors, 1); // "أربعة" is not a number
    assert.ok(dry.body.issues.some((i: { row: number; column: string; kind: string }) => i.row === 5 && i.column === 'المعالجات' && i.kind === 'error'));
    assert.ok(dry.body.issues.some((i: { row: number; kind: string }) => i.row === 6 && i.kind === 'warning'));
    assert.equal((await api(T.ea, 'GET', '/records?block=server&q=SRV-WZ')).body.total, 0);

    const fixed = book();
    fixed.worksheets[0].getCell('C5').value = 4;
    const run = await wizard('run', fixed, { mapping: mapping({ dry_run: false }) });
    assert.equal(run.body.saved, true, JSON.stringify(run.body));
    assert.equal(run.body.created, 2);
    assert.equal(run.body.linked, 2);
    const list = (await api(T.ea, 'GET', '/records?block=server&q=SRV-WZ')).body;
    assert.equal(list.total, 2);
    const s1 = list.items.find((x: { name: string }) => x.name === 'SRV-WZ-01');
    assert.equal(s1.attrs.random_access_memory_ram, 16);
    assert.equal((await api(T.ea, 'GET', '/records?block=application&q=تطبيق المعالج')).body.total, 2);

    const again = await wizard('run', fixed, { mapping: mapping({ dry_run: false }) });
    assert.equal(again.body.created, 0);
    assert.equal(again.body.updated, 0);
    assert.equal(again.body.unchanged, 3);
    assert.equal((await api(T.ea, 'GET', '/records?block=server&q=SRV-WZ')).body.total, 2);
  });

  it('approves many records at once, keeping maker-checker', async () => {
    const ids = (await api(T.ea, 'GET', '/records?block=server&q=SRV-WZ')).body.items.map((x: { id: string }) => x.id);
    const sub = await api(T.ea, 'POST', '/records-bulk', { ids, action: 'submit' });
    assert.equal(sub.body.done, 2, JSON.stringify(sub.body));
    const self = await api(T.ea, 'POST', '/records-bulk', { ids, action: 'approve' });
    assert.equal(self.body.done, 0);
    assert.equal(self.body.failed.length, 2);
  });
});

describe('reports centre', () => {
  it('builds every report for an architect, within scope, and exports them marked with the classification', async () => {
    for (const code of ['inventory', 'quality', 'lifecycle', 'relations', 'cost', 'workflow']) {
      const r = await api(T.ea, 'GET', `/reports/${code}`);
      assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.body)}`);
    }
    const inv = (await api(T.ea, 'GET', '/reports/inventory')).body;
    assert.ok(inv.total > 0);
    assert.equal(inv.rows.reduce((a: number, x: { total: number }) => a + x.total, 0), inv.total);
    const q = (await api(T.ea, 'GET', '/reports/quality')).body;
    assert.ok(q.score >= 0 && q.score <= 1);
    assert.ok(q.blocks.every((b: { fill: unknown[] }) => b.fill.length > 0));

    const res = await fetch(`${base}/reports/quality/xlsx?lang=en`, { headers: { authorization: `Bearer ${T.ea}` } });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    assert.equal(wb.worksheets[0].name, 'About');
    assert.match(String(wb.worksheets[0].getCell('B4').value), /Restricted/);
    assert.ok(wb.worksheets.every((ws) => /Classification: Restricted/.test(ws.headerFooter.oddHeader ?? '')));
  });

  it('flags a licence that has expired', async () => {
    const lic = await api(T.ea, 'POST', '/records', { block: 'license', attrs: { license_name: 'رخصة منتهية للتقرير', expiry_date: '2020-01-01' } });
    assert.equal(lic.status, 201, JSON.stringify(lic.body));
    const l = (await api(T.ea, 'GET', '/reports/lifecycle')).body;
    const it = l.items.find((x: { record_id: string }) => x.record_id === lic.body.id);
    assert.equal(it.bucket, 'expired');
    assert.ok(l.counts.expired >= 1);
  });

  it('hides costs from roles without cost access and refuses unknown reports', async () => {
    assert.equal((await api(T.entry, 'GET', '/reports/cost')).status, 403);
    // A scoped data-entry user sees only the technology domain.
    const inv = (await api(T.entry, 'GET', '/reports/inventory')).body;
    assert.ok(inv.rows.length > 0 && inv.rows.every((r: { domain: string }) => r.domain === 'technology'));
    assert.equal((await api(T.ea, 'GET', '/reports/nope')).status, 400);
    assert.equal((await api(T.platform, 'GET', '/reports/inventory')).status, 403);
  });
});
