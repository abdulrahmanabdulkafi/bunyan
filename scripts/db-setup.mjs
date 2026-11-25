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

// National compliance content (structure only; control texts are loaded by the platform admin).
{
  await db.query('begin');
  await db.query(`select set_config('app.platform','on',true)`);
  for (const f of fs.readdirSync(path.join(root, 'packages/seed')).filter((x) => /^(nca|ndmo|dga)-.*\.json$/.test(x))) {
    const fw = JSON.parse(fs.readFileSync(path.join(root, 'packages/seed', f), 'utf8'));
    const id = (await db.query(`insert into compliance_frameworks (code, version, name_ar, name_en, issuer_ar, issuer_en) values ($1,$2,$3,$4,$5,$6)
      on conflict (code, version) do update set name_ar = excluded.name_ar returning id`, [fw.code, fw.version, fw.name_ar, fw.name_en, fw.issuer_ar, fw.issuer_en])).rows[0].id;
    // Upsert by code: a newer seed refreshes texts without touching entities' assessments (they reference item ids).
    for (const it of fw.items) {
      const parent = it.parent ? (await db.query('select id from compliance_items where framework_id=$1 and code=$2', [id, it.parent])).rows[0].id : null;
      await db.query(`insert into compliance_items (framework_id, parent_id, code, level, title_ar, title_en, text_ar, text_en, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (framework_id, code) do update set parent_id=excluded.parent_id, level=excluded.level, title_ar=excluded.title_ar,
          title_en=excluded.title_en, text_ar=excluded.text_ar, text_en=excluded.text_en, sort=excluded.sort`,
        [id, parent, it.code, it.level, it.title_ar, it.title_en ?? null, it.text_ar ?? null, it.text_en ?? null, it.sort]);
    }
    console.log(`library ${fw.code}-${fw.version}: ${fw.items.length} items`);
  }
  await db.query('commit');
}

// Keep every existing entity in step with the national meta-model template (idempotent; never undoes an entity's own choices).
{
  const { syncTemplate } = await import(path.join(root, 'apps/api/dist/tenants/tenants.js'));
  const tenants = (await db.query(`select set_config('app.platform','on',false); select id from tenants where kind = 'entity'`))[1].rows;
  for (const t of tenants) {
    await db.query('begin');
    await db.query(`select set_config('app.platform','on',true)`);
    await syncTemplate(db, t.id);
    await db.query('commit');
  }
  if (tenants.length) console.log(`meta-model template synced for ${tenants.length} entities`);
}

if (demo) {
  const { applyTemplate } = await import(path.join(root, 'apps/api/dist/tenants/tenants.js'));
  await db.query('begin');
  await db.query(`select set_config('app.platform','on',true)`);
  const T = async (code, name_ar, name_en, kind, parent) =>
    (await db.query(`insert into tenants (code,name_ar,name_en,kind,parent_id) values ($1,$2,$3,$4,$5) on conflict (code) do update set name_ar=excluded.name_ar, name_en=excluded.name_en returning id`, [code, name_ar, name_en, kind, parent])).rows[0].id;
  const sector = await T('sector-economy', 'المكتب القطاعي — الاقتصاد', 'Sector office — Economy', 'sector', null);
  const ea = await T('entity-a', 'الجهة التجريبية (أ)', 'Demo entity A', 'entity', sector);
  const eb = await T('entity-b', 'الجهة التجريبية (ب)', 'Demo entity B', 'entity', sector);
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
    [ea, block, attrs.name ?? attrs.server_name ?? attrs.license_name ?? attrs.service_name ?? attrs.code, JSON.stringify(attrs), status, arch])).rows[0].id;
  const L = async (s, verb, t, sb, tb) => {
    const rel = (await db.query('select id from mm_relations where tenant_id=$1 and source_code=$2 and verb=$3 and target_code=$4', [ea, sb, verb, tb])).rows[0];
    if (!rel) throw new Error(`demo relation missing: ${sb} ${verb} ${tb}`);
    await db.query('insert into record_links (tenant_id, relation_id, source_id, target_id) values ($1,$2,$3,$4) on conflict do nothing', [ea, rel.id, s, t]);
  };
  const crm = await R('application', { code: 'APP-001', name: 'نظام إدارة علاقات العملاء', description: 'إدارة المستفيدين والطلبات', layer: 'تطبيقات الأعمال', development_type: 'منتج جاهز', application_status: 'قيد التشغيل', importance: 'عالية', launch_date: '2021-03-01', capital_cost: 1200000, operating_cost: 300000 });
  const erp = await R('application', { code: 'APP-002', name: 'نظام تخطيط الموارد', description: 'الموارد البشرية والمالية', layer: 'تطبيقات الدعم', development_type: 'منتج جاهز', application_status: 'قيد التشغيل', importance: 'عالية', launch_date: '2019-01-15', capital_cost: 5000000, operating_cost: 900000 });
  const portal = await R('application', { code: 'APP-003', name: 'البوابة الإلكترونية', description: 'بوابة الخدمات للمستفيدين', layer: 'قنوات الوصول', development_type: 'تطوير داخلي', application_status: 'قيد التطوير' }, 'draft');
  const dms = await R('application', { code: 'APP-004', name: 'نظام إدارة الوثائق', description: 'الأرشفة الإلكترونية والمراسلات', layer: 'تطبيقات الدعم', development_type: 'تطوير خارجي', application_status: 'قيد التشغيل', importance: 'متوسطة' });
  const mod1 = await R('application_modules', { name: 'إدارة الطلبات', description: 'استقبال الطلبات وتتبعها' });
  const mod2 = await R('application_modules', { name: 'إدارة الحسابات', description: 'ملفات المستفيدين' });
  const mod3 = await R('application_modules', { name: 'الرواتب', description: 'مسيرات الرواتب' });
  const dc1 = await R('data_center', { code: 'DC-01', name: 'مركز البيانات الرئيسي — الرياض', role: 'رئيسي', environment: 'الإنتاج', type_of_operation: 'داخلي' });
  const dc2 = await R('data_center', { code: 'DC-02', name: 'مركز التعافي — جدة', role: 'تعافٍ من الكوارث', environment: 'التعافي', type_of_operation: 'مُسند' });
  const h1 = await R('physical_host', { name: 'ESX-RUH-01', manufacturer: 'Dell', model: 'PowerEdge R760', cluster_id: 'CL-PROD', total_number_of_physical_cpu_cores: 64, physical_random_access_memory_ram: 1024, support_end_date: '2029-06-30' });
  const h2 = await R('physical_host', { name: 'ESX-JED-01', manufacturer: 'HPE', model: 'ProLiant DL380', cluster_id: 'CL-DR', total_number_of_physical_cpu_cores: 32, physical_random_access_memory_ram: 512, support_end_date: new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10) });
  const s1 = await R('server', { server_name: 'SRV-CRM-01', server_type: 'افتراضي', operating_system_type: 'Linux', environment: 'الإنتاج', central_processing_units: 8, random_access_memory_ram: 32 });
  const s2 = await R('server', { server_name: 'SRV-ERP-01', server_type: 'مادي', operating_system_type: 'Windows Server', environment: 'الإنتاج', central_processing_units: 16, random_access_memory_ram: 128 });
  const s3 = await R('server', { server_name: 'SRV-DMS-01', server_type: 'افتراضي', operating_system_type: 'Linux', environment: 'الإنتاج', central_processing_units: 4, random_access_memory_ram: 16 });
  const st = await R('storage', { name: 'SAN-RUH-01', manufacturer: 'NetApp', model: 'AFF A400', storage_capacity: 200 });
  const nd1 = await R('network_device', { name: 'CORE-SW-01', manufacturer: 'Cisco', model: 'Nexus 9300', type: 'مبدّل', function: 'شبكة النواة' });
  const nd2 = await R('network_device', { name: 'WAN-RTR-01', manufacturer: 'Cisco', model: 'ASR 1001', type: 'موجّه', function: 'الربط الخارجي' });
  const nl = await R('network_link', { code: 'MPLS-RUH-JED', location: 'الرياض — جدة', bandwidth: 1000, technology: 'MPLS', role: 'ربط مراكز البيانات' });
  const i1 = await R('technical_integration_interface', { code: 'INT-001', name: 'تكامل العملاء مع المالية', consumer: 'نظام تخطيط الموارد', product: 'نظام إدارة علاقات العملاء', data_format: 'JSON', integration_type: 'API' });
  const i2 = await R('technical_integration_interface', { code: 'INT-002', name: 'أرشفة مرفقات الطلبات', consumer: 'نظام إدارة الوثائق', product: 'نظام إدارة علاقات العملاء', data_format: 'XML', integration_type: 'خدمة ويب' });
  await R('license', { code: 'LIC-001', license_name: 'رخص قاعدة البيانات', quantity: 20, expiry_date: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10) });
  const fw = await R('security_hardware', { code: 'SEC-001', name: 'جدار الحماية الرئيسي', model: 'FW-5000', function: 'جدار حماية', support_end_date: '2026-01-31' });
  const waf = await R('security_hardware', { code: 'SEC-002', name: 'جدار حماية تطبيقات الويب', model: 'WAF-2', function: 'حماية تطبيقات الويب' });
  const edr = await R('security_software', { code: 'SSW-001', name: 'منصة حماية الأجهزة الطرفية', version: '8.1', function: 'حماية الأجهزة الطرفية' });
  await R('security_service', { code: 'SSV-001', service_name: 'مركز العمليات الأمنية', function: 'المراقبة الأمنية', type_of_operation: 'مُسند' });
  for (const [app, srv] of [[crm, s1], [erp, s2], [portal, s1], [dms, s3]]) await L(srv, 'Hosts', app, 'server', 'application');
  await L(crm, 'Contains', mod1, 'application', 'application_modules');
  await L(crm, 'Contains', mod2, 'application', 'application_modules');
  await L(erp, 'Contains', mod3, 'application', 'application_modules');
  await L(crm, 'Provides', i1, 'application', 'technical_integration_interface');
  await L(i1, 'Consumed By', erp, 'technical_integration_interface', 'application');
  await L(crm, 'Provides', i2, 'application', 'technical_integration_interface');
  await L(i2, 'Consumed By', dms, 'technical_integration_interface', 'application');
  for (const [blk, id] of [['physical_host', h1], ['storage', st], ['network_device', nd1], ['network_device', nd2], ['security_hardware', fw], ['security_hardware', waf], ['security_software', edr], ['server', s2]]) await L(dc1, 'Hosts', id, 'data_center', blk);
  await L(dc2, 'Hosts', h2, 'data_center', 'physical_host');
  await L(h1, 'Hosts', s1, 'physical_host', 'server');
  await L(h1, 'Hosts', s3, 'physical_host', 'server');
  await L(nl, 'Hosted In', dc1, 'network_link', 'data_center');
  await L(nl, 'Hosted In', dc2, 'network_link', 'data_center');
  await L(nd2, 'Linked Through', nl, 'network_device', 'network_link');
  await L(fw, 'Secures', crm, 'security_hardware', 'application');
  await L(waf, 'Secures', portal, 'security_hardware', 'application');
  await L(edr, 'Secures', s1, 'security_software', 'server');
  await L(edr, 'Secures', erp, 'security_software', 'application');

  // Compliance demo: entity A adopts ECC and maps a few security assets to subdomains.
  const ecc = (await db.query(`select id from compliance_frameworks where code='ECC' and version='2:2024'`)).rows[0].id;
  await db.query('insert into tenant_frameworks (tenant_id, framework_id, enabled) values ($1,$2,true) on conflict do nothing', [ea, ecc]);
  const item = async (code) => (await db.query('select id from compliance_items where framework_id=$1 and code=$2', [ecc, code])).rows[0].id;
  const A = (code, rec, status, extra = {}) => item(code).then((iid) => db.query(
    `insert into control_assessments (tenant_id, item_id, record_id, status, evidence, assessed_at, remediation, due_date, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ea, iid, rec, status, extra.evidence ?? null, extra.assessed_at ?? null, extra.remediation ?? null, extra.due_date ?? null, owner]));
  await A('2-5-3-1', fw, 'compliant');
  await A('2-5-3-1', null, 'compliant', { evidence: 'مخطط تقسيم الشبكة المعتمد وتقرير مراجعة قواعد الجدار الناري', assessed_at: '2026-10-01' });
  await A('2-15-3-1', waf, 'compliant');
  await A('2-15-3-1', null, 'partial', { evidence: 'جدار حماية تطبيقات الويب يغطي البوابة فقط', remediation: 'توسيع الحماية لتشمل نظام إدارة علاقات العملاء', due_date: '2027-03-31' });
  await A('2-3-3-1', edr, 'compliant');
  await A('2-3-3-1', null, 'compliant', { assessed_at: '2026-09-15' });
  await A('2-12-3-1', null, 'non_compliant', { remediation: 'ربط السجلات بمركز العمليات الأمنية', due_date: '2027-01-31' });
  await A('1-3-1', null, 'compliant');
  await db.query('commit');
  console.log('demo data loaded (password:', process.env.DEMO_PASSWORD ?? 'Bunyan@2026', ')');
}
await db.end();
