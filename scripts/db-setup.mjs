// Creates roles + database, applies SQL migrations, and (with --demo) loads demo tenants, users and records.
// Usage: ADMIN_DATABASE_URL=postgres://postgres@localhost:5432/postgres node scripts/db-setup.mjs [--demo]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const admin = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
const dbName = process.env.DB_NAME ?? 'bunyan';
const ownerPw = process.env.DB_OWNER_PASSWORD ?? 'bunyan_owner';
const appPw = process.env.DB_APP_PASSWORD ?? 'bunyan_app';
const demo = process.argv.includes('--demo');
const reset = process.argv.includes('--reset');

const a = new pg.Client({ connectionString: admin });
await a.connect();
if (reset) await a.query(`drop database if exists ${dbName} with (force)`);
for (const [role, pw] of [['bunyan_owner', ownerPw], ['bunyan_app', appPw]]) {
  const exists = (await a.query('select 1 from pg_roles where rolname=$1', [role])).rowCount;
  await a.query(`${exists ? 'alter' : 'create'} role ${role} login nosuperuser nobypassrls password '${pw.replace(/'/g, "''")}'`);
}
if (!(await a.query(`select 1 from pg_roles where rolname='bunyan_definer'`)).rowCount) await a.query('create role bunyan_definer nologin bypassrls');
await a.query('grant bunyan_definer to bunyan_owner');
if (!(await a.query('select 1 from pg_database where datname=$1', [dbName])).rowCount) {
  await a.query(`create database ${dbName} owner bunyan_owner encoding 'UTF8' template template0`);
}
await a.end();

// pgcrypto needs a superuser once per database
const su = new pg.Client({ connectionString: admin.replace(/\/[^/]*$/, `/${dbName}`) });
await su.connect(); await su.query('create extension if not exists pgcrypto'); await su.end();

const url = new URL(admin); url.username = 'bunyan_owner'; url.password = ownerPw; url.pathname = `/${dbName}`;
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())');
for (const f of fs.readdirSync(path.join(root, 'db')).filter((f) => f.endsWith('.sql')).sort()) {
  if ((await db.query('select 1 from schema_migrations where name=$1', [f])).rowCount) continue;
  await db.query('begin');
  await db.query(fs.readFileSync(path.join(root, 'db', f), 'utf8'));
  await db.query('insert into schema_migrations(name) values ($1)', [f]);
  await db.query('commit');
  console.log('applied', f);
}

if (demo) {
  const { applyTemplate } = await import(path.join(root, 'apps/api/dist/tenants/tenants.js'));
  await db.query('begin');
  await db.query(`select set_config('app.platform','on',true)`);
  const T = async (code, name_ar, kind, parent) =>
    (await db.query(`insert into tenants (code,name_ar,kind,parent_id) values ($1,$2,$3,$4) on conflict (code) do update set name_ar=excluded.name_ar returning id`, [code, name_ar, kind, parent])).rows[0].id;
  const sector = await T('sector-economy', 'المكتب القطاعي — الاقتصاد', 'sector', null);
  const ea = await T('entity-a', 'الجهة التجريبية (أ)', 'entity', sector);
  const eb = await T('entity-b', 'الجهة التجريبية (ب)', 'entity', sector);
  for (const t of [ea, eb]) await applyTemplate(db, t);
  const pw = await bcrypt.hash(process.env.DEMO_PASSWORD ?? 'Bunyan@2026', 10);
  const U = async (email, name, tenant, roles, scope = {}) =>
    (await db.query(`insert into users (tenant_id,email,display_name,password_hash,roles,scope) values ($1,$2,$3,$4,$5,$6)
      on conflict (email) do update set roles=excluded.roles, scope=excluded.scope, password_hash=excluded.password_hash returning id`,
      [tenant, email, name, pw, roles, JSON.stringify(scope)])).rows[0].id;
  await U('platform@bunyan.local', 'مدير المنصة', null, ['R0']);
  await U('national@bunyan.local', 'مستعرض اللوحة الوطنية', null, ['R8']);
  await U('sector@bunyan.local', 'مسؤول المكتب القطاعي', sector, ['R9']);
  await U('admin@a.local', 'مدير النظام', ea, ['R1']);
  const owner = await U('ea@a.local', 'مسؤول البنية المؤسسية', ea, ['R2']);
  const arch = await U('architect@a.local', 'مهندس البنية', ea, ['R3']);
  await U('tech-owner@a.local', 'مالك بيانات التقنية', ea, ['R4'], { domains: ['technology'] });
  await U('entry@a.local', 'مدخل بيانات التقنية', ea, ['R5'], { domains: ['technology'] });
  await U('viewer@a.local', 'قيادي', ea, ['R6']);
  await U('auditor@a.local', 'مدقق امتثال', ea, ['R7']);
  await U('ea@b.local', 'مسؤول البنية — ب', eb, ['R2']);

  // Sample repository for entity A
  await db.query(`select set_config('app.tenant_id',$1,true)`, [ea]);
  const R = async (block, attrs, status = 'approved') => (await db.query(
    `insert into records (tenant_id, block_code, name, attrs, status, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id`,
    [ea, block, attrs.name ?? attrs.server_name ?? attrs.license_name ?? attrs.code, JSON.stringify(attrs), status, arch])).rows[0].id;
  const L = async (s, verb, t, sb, tb) => {
    const rel = (await db.query('select id from mm_relations where tenant_id=$1 and source_code=$2 and verb=$3 and target_code=$4', [ea, sb, verb, tb])).rows[0];
    if (rel) await db.query('insert into record_links (tenant_id, relation_id, source_id, target_id) values ($1,$2,$3,$4) on conflict do nothing', [ea, rel.id, s, t]);
  };
  const crm = await R('application', { code: 'APP-001', name: 'نظام إدارة علاقات العملاء', description: 'إدارة المستفيدين والطلبات', layer: 'تطبيقات الأعمال', application_status: 'قيد التشغيل', launch_date: '2021-03-01', capital_cost: 1200000, operating_cost: 300000 });
  const erp = await R('application', { code: 'APP-002', name: 'نظام تخطيط الموارد', description: 'الموارد البشرية والمالية', layer: 'تطبيقات الدعم', application_status: 'قيد التشغيل', launch_date: '2019-01-15', capital_cost: 5000000, operating_cost: 900000 });
  const portal = await R('application', { code: 'APP-003', name: 'البوابة الإلكترونية', description: 'بوابة الخدمات للمستفيدين', layer: 'قنوات الوصول', application_status: 'قيد التطوير' }, 'draft');
  const s1 = await R('server', { server_name: 'SRV-CRM-01', server_type: 'افتراضي', operating_system_type: 'Linux', environment: 'الإنتاج', central_processing_units: 8, random_access_memory_ram: 32 });
  const s2 = await R('server', { server_name: 'SRV-ERP-01', server_type: 'مادي', operating_system_type: 'Windows Server', environment: 'الإنتاج', central_processing_units: 16, random_access_memory_ram: 128 });
  const i1 = await R('technical_integration_interface', { code: 'INT-001', name: 'تكامل العملاء مع المالية', consumer: 'نظام تخطيط الموارد', product: 'نظام إدارة علاقات العملاء', data_format: 'JSON' });
  await R('license', { code: 'LIC-001', license_name: 'رخص قاعدة البيانات', quantity: 20, expiry_date: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10) });
  await R('security_hardware', { code: 'SEC-001', name: 'جدار الحماية الرئيسي', model: 'FW-5000', support_end_date: '2026-01-31' });
  for (const [app, srv] of [[crm, s1], [erp, s2], [portal, s1]]) await L(srv, 'Hosts', app, 'server', 'application');
  await L(crm, 'Provides', i1, 'application', 'technical_integration_interface');
  await L(i1, 'Consumed By', erp, 'technical_integration_interface', 'application');
  await db.query('commit');
  console.log('demo data loaded (password:', process.env.DEMO_PASSWORD ?? 'Bunyan@2026', ')');
}
await db.end();
