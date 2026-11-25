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

// Demo data is loaded once: re-running setup (e.g. every `docker compose up`) must not duplicate it. Use --reset to start over.
const demoLoaded = demo && (await db.query(`select set_config('app.platform','on',false); select 1 from tenants where code = 'entity-a'`))[1].rowCount > 0;
if (demoLoaded) console.log('demo data already present (run with --reset to reload it)');
if (demo && !demoLoaded) {
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
  const R = async (block, attrs, status = 'approved', title) => (await db.query(
    `insert into records (tenant_id, block_code, name, attrs, status, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id`,
    [ea, block, title ?? attrs.name ?? attrs.server_name ?? attrs.license_name ?? attrs.service_name ?? attrs.code, JSON.stringify(attrs), status, arch])).rows[0].id;
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

  // Strategy, business, beneficiary and data — so every domain and its viewpoints have something to show.
  const vision = await R('vision', { vision_statement: 'خدمات حكومية رقمية رائدة تضع المستفيد أولاً', scope_of_the_vision: 'الجهة كاملة' }, 'approved', 'خدمات حكومية رقمية رائدة تضع المستفيد أولاً');
  const mission = await R('mission', { mission_statement: 'تقديم خدمات متكاملة وموثوقة عبر قنوات رقمية آمنة', scope_of_the_mission: 'الجهة كاملة' }, 'approved', 'تقديم خدمات متكاملة وموثوقة عبر قنوات رقمية آمنة');
  const pil1 = await R('pillar', { code: 'P-01', name: 'التحول الرقمي', description: 'رقمنة الخدمات والإجراءات' });
  const pil2 = await R('pillar', { code: 'P-02', name: 'الكفاءة التشغيلية', description: 'خفض التكلفة ورفع الجودة' });
  const ob1 = await R('objective', { code: 'OBJ-01', name: 'رقمنة 90% من الخدمات', type: 'استراتيجي', description: 'تقديم الخدمات إلكترونياً من طرف إلى طرف' });
  const ob2 = await R('objective', { code: 'OBJ-02', name: 'رفع رضا المستفيدين', type: 'استراتيجي', description: 'تحسين تجربة المستفيد في كل القنوات' });
  const ob3 = await R('objective', { code: 'OBJ-03', name: 'خفض تكاليف التشغيل التقني', type: 'تشغيلي', description: 'توحيد المنصات وترشيد الرخص' });
  const in1 = await R('initiative', { code: 'INI-01', name: 'منصة الخدمات الموحدة', type: 'Strategic initiative', start_date: '2025-01-01', completion_date: '2027-12-31', budget: 15000000 });
  const in2 = await R('initiative', { code: 'INI-02', name: 'برنامج تحسين تجربة المستفيد', type: 'Strategic initiative', start_date: '2025-06-01', completion_date: '2026-12-31', budget: 4000000 });
  const in3 = await R('initiative', { code: 'INI-03', name: 'توحيد البنية التحتية', type: 'Technical initiative', start_date: '2025-03-01', completion_date: '2027-06-30', budget: 9000000 });
  const pr1 = await R('project', { code: 'PRJ-01', name: 'تطوير البوابة الإلكترونية', status_of_the_project: 'Active', entity_in_charge_of_execution: 'In-house execution', start_date: '2025-02-01', completion_date: '2026-12-31', budget: 6000000, currency: 'Saudi Riyal' });
  const pr2 = await R('project', { code: 'PRJ-02', name: 'ترحيل الخدمات إلى نظام إدارة العملاء', status_of_the_project: 'Scheduled', entity_in_charge_of_execution: 'Outsourced execution', budget: 3500000, currency: 'Saudi Riyal' });
  const pr3 = await R('project', { code: 'PRJ-03', name: 'دمج مراكز البيانات', status_of_the_project: 'Active', entity_in_charge_of_execution: 'Outsourced execution', budget: 7000000, currency: 'Saudi Riyal' });
  const kpi1 = await R('key_performance_indicator', { code: 'KPI-01', name: 'نسبة الخدمات الرقمية', indicator_level: 'Strategic', measurement_unit: 'Percentage', measurement_periodicity: 'Quarterly', polarity_of_measurement: 'Ascending', baseline_value: 55, target_value: 90, actual_indicator_value: 72 });
  const kpi2 = await R('key_performance_indicator', { code: 'KPI-02', name: 'مؤشر رضا المستفيدين', indicator_level: 'Strategic', measurement_unit: 'Percentage', measurement_periodicity: 'Semi-annual', polarity_of_measurement: 'Ascending', baseline_value: 68, target_value: 85, actual_indicator_value: 77 });
  const ou1 = await R('organizational_unit', { name: 'وكالة الخدمات الرقمية', type: 'Sector', description: 'تقديم الخدمات الإلكترونية وتطويرها' });
  const ou2 = await R('organizational_unit', { name: 'الإدارة العامة لتقنية المعلومات', type: 'Public administration', description: 'تشغيل البنية التقنية والتطبيقات' });
  const ou3 = await R('organizational_unit', { name: 'الإدارة العامة لخدمة المستفيدين', type: 'Public administration', description: 'قنوات التواصل وإدارة الطلبات' });
  const cap1 = await R('business_capability', { name: 'إدارة الطلبات', capability_type: 'Operational', capability_maturity_level: 'Medium maturity capability' });
  const cap2 = await R('business_capability', { name: 'إدارة علاقات المستفيدين', capability_type: 'Strategic', capability_maturity_level: 'Low maturity capability' });
  const cap3 = await R('business_capability', { name: 'إدارة الموارد المالية', capability_type: 'Supporting', capability_maturity_level: 'High maturity capability' });
  const cap4 = await R('business_capability', { name: 'إدارة الوثائق والمراسلات', capability_type: 'Supporting', capability_maturity_level: 'Medium maturity capability' });
  const sv1 = await R('service', { code: 'SRV-01', name: 'إصدار ترخيص', service_type: 'Core', classification: 'Core service', automation_level: 'Fully automated', type_of_beneficiary: 'Private sector', geographic_coverage: 'All areas of the Kingdom' });
  const sv2 = await R('service', { code: 'SRV-02', name: 'تجديد ترخيص', service_type: 'Core', classification: 'Sub-service', automation_level: 'Partially automated', type_of_beneficiary: 'Private sector', geographic_coverage: 'All areas of the Kingdom' });
  const sv3 = await R('service', { code: 'SRV-03', name: 'تقديم شكوى أو بلاغ', service_type: 'Supporting', classification: 'Core service', automation_level: 'Manual', type_of_beneficiary: 'Individual', geographic_coverage: 'All areas of the Kingdom' });
  const pg1 = await R('processes_group', { code: 'PG-01', name: 'إجراءات الترخيص' });
  const pg2 = await R('processes_group', { code: 'PG-02', name: 'إجراءات خدمة المستفيد' });
  const bp1 = await R('business_process', { code: 'BP-01', name: 'استقبال طلب الترخيص والتحقق منه' });
  const bp2 = await R('business_process', { code: 'BP-02', name: 'دراسة الطلب وإصدار القرار' });
  const bp3 = await R('business_process', { code: 'BP-03', name: 'معالجة الشكاوى' });
  const ben1 = await R('beneficiary', { name: 'المنشآت التجارية', type: 'Business sector', description: 'الشركات والمؤسسات طالبة التراخيص' });
  const ben2 = await R('beneficiary', { name: 'المواطنون والمقيمون', type: 'Individuals', description: 'الأفراد المستفيدون من الخدمات' });
  const per1 = await R('persona', { code: 'PER-01', name: 'صاحب منشأة صغيرة', objectives: 'إنجاز الترخيص بسرعة ودون مراجعة حضورية' });
  const jr1 = await R('beneficiary_journey', { code: 'JR-01', description: 'رحلة الحصول على ترخيص', objective: 'ترخيص خلال 3 أيام عمل' }, 'approved', 'JR-01');
  const ph1 = await R('phase', { code: 'PH-01', name: 'التقديم' });
  const ph2 = await R('phase', { code: 'PH-02', name: 'المتابعة والاستلام' });
  const sp1 = await R('step', { code: 'ST-01', name: 'تعبئة نموذج الطلب', communication_channel: 'Digital platforms', associated_gaps: 'تكرار إدخال بيانات السجل التجاري' });
  const sp2 = await R('step', { code: 'ST-02', name: 'رفع المرفقات', communication_channel: 'Digital platforms' });
  const sp3 = await R('step', { code: 'ST-03', name: 'استلام الترخيص', communication_channel: 'E-mail' });
  const de1 = await R('data_entity', { code: 'DE-01', name: 'بيانات المستفيد', data_entity_classification: 'Restricted', storage_classification: 'Inside the Kingdom only', structure_classification: 'Structured', data_source: 'نظام إدارة علاقات العملاء' });
  const de2 = await R('data_entity', { code: 'DE-02', name: 'بيانات الترخيص', data_entity_classification: 'Restricted', storage_classification: 'Inside the Kingdom only', structure_classification: 'Structured' });
  const de3 = await R('data_entity', { code: 'DE-03', name: 'البيانات المالية', data_entity_classification: 'Secret', storage_classification: 'Inside the Kingdom only', structure_classification: 'Structured', data_source: 'نظام تخطيط الموارد' });
  const de4 = await R('data_entity', { code: 'DE-04', name: 'دليل الخدمات المنشور', data_entity_classification: 'Public', storage_classification: 'May be stored outside the Kingdom', structure_classification: 'Semi-structured' });
  const da1 = await R('data_attributes', { name: 'رقم الهوية', type: 'نص', classification: 'مقيد' });
  const da2 = await R('data_attributes', { name: 'رقم الجوال', type: 'نص', classification: 'مقيد' });
  const dv1 = await R('data_vault', { code: 'DV-01', name: 'قاعدة بيانات العملاء', type: 'قاعدة بيانات علائقية' });
  const dv2 = await R('data_vault', { code: 'DV-02', name: 'قاعدة بيانات الموارد', type: 'قاعدة بيانات علائقية' });

  await L(vision, 'Leads', mission, 'vision', 'mission');
  for (const o of [ob1, ob2, ob3]) await L(mission, 'Translates To', o, 'mission', 'objective');
  await L(ob1, 'Belongs To', pil1, 'objective', 'pillar');
  await L(ob2, 'Belongs To', pil1, 'objective', 'pillar');
  await L(ob3, 'Belongs To', pil2, 'objective', 'pillar');
  for (const [o, i] of [[ob1, in1], [ob2, in2], [ob1, in2], [ob3, in3]]) await L(o, 'Achieved Through', i, 'objective', 'initiative');
  for (const [i, p] of [[in1, pr1], [in1, pr2], [in3, pr3]]) await L(i, 'Contains', p, 'initiative', 'project');
  for (const [i, u] of [[in1, ou1], [in2, ou3], [in3, ou2]]) await L(i, 'Executed By', u, 'initiative', 'organizational_unit');
  await L(ob1, 'Measured', kpi1, 'objective', 'key_performance_indicator');
  await L(ob2, 'Measured', kpi2, 'objective', 'key_performance_indicator');
  for (const [u, c] of [[ou1, cap1], [ou3, cap2], [ou2, cap4], [ou2, cap3]]) await L(u, 'Owns', c, 'organizational_unit', 'business_capability');
  for (const [u, sv] of [[ou1, sv1], [ou1, sv2], [ou3, sv3]]) await L(u, 'Owns', sv, 'organizational_unit', 'service');
  await L(cap1, 'Implemented Through', pg1, 'business_capability', 'processes_group');
  await L(cap2, 'Implemented Through', pg2, 'business_capability', 'processes_group');
  await L(pg1, 'Consists Of', bp1, 'processes_group', 'business_process');
  await L(pg1, 'Consists Of', bp2, 'processes_group', 'business_process');
  await L(pg2, 'Consists Of', bp3, 'processes_group', 'business_process');
  for (const [sv, bp] of [[sv1, bp1], [sv1, bp2], [sv2, bp1], [sv2, bp2], [sv3, bp3]]) await L(sv, 'Provided Through', bp, 'service', 'business_process');
  for (const [sv, b] of [[sv1, ben1], [sv2, ben1], [sv3, ben2], [sv3, ben1]]) await L(sv, 'Provided To', b, 'service', 'beneficiary');
  for (const [sv, a] of [[sv1, portal], [sv1, crm], [sv2, portal], [sv3, crm]]) await L(sv, 'Automated', a, 'service', 'application');
  for (const [bp, a] of [[bp1, crm], [bp2, dms], [bp3, crm]]) await L(bp, 'Automated', a, 'business_process', 'application');
  await L(kpi1, 'Measures', sv1, 'key_performance_indicator', 'service');
  await L(ben1, 'Represents', per1, 'beneficiary', 'persona');
  await L(jr1, 'Belongs To', per1, 'beneficiary_journey', 'persona');
  await L(jr1, 'Includes', ph1, 'beneficiary_journey', 'phase');
  await L(jr1, 'Includes', ph2, 'beneficiary_journey', 'phase');
  await L(ph1, 'Includes', sp1, 'phase', 'step');
  await L(ph1, 'Includes', sp2, 'phase', 'step');
  await L(ph2, 'Includes', sp3, 'phase', 'step');
  for (const [d, a] of [[de1, crm], [de1, portal], [de2, crm], [de2, dms], [de3, erp], [de4, portal]]) await L(d, 'Used In', a, 'data_entity', 'application');
  for (const [d, u] of [[de1, ou3], [de2, ou1], [de3, ou2]]) await L(d, 'Linked To', u, 'data_entity', 'organizational_unit');
  await L(de1, 'Described Through', da1, 'data_entity', 'data_attributes');
  await L(de1, 'Described Through', da2, 'data_entity', 'data_attributes');
  await L(dv1, 'Contains', de1, 'data_vault', 'data_entity');
  await L(dv1, 'Contains', de2, 'data_vault', 'data_entity');
  await L(dv2, 'Contains', de3, 'data_vault', 'data_entity');
  await L(dv1, 'Hosted', s1, 'data_vault', 'server');
  await L(dv2, 'Hosted', s2, 'data_vault', 'server');

  // An EA development cycle in its target phase: what the entity plans to add, change and retire.
  {
    const lic = await R('application', { code: 'APP-005', name: 'منصة التراخيص الموحدة', description: 'منصة واحدة لكل التراخيص تحل محل نظام إدارة الوثائق في مسار الترخيص', layer: 'تطبيقات الأعمال', development_type: 'تطوير داخلي', application_status: 'مخطط' }, 'draft');
    await L(sv1, 'Automated', lic, 'service', 'application');
    await L(sv2, 'Automated', lic, 'service', 'application');
    await L(de2, 'Used In', lic, 'data_entity', 'application');
    await L(s1, 'Hosts', lic, 'server', 'application');
    const cyc = (await db.query(
      `insert into ea_cycles (tenant_id, code, name, objective, domains, start_date, end_date, status, phase, owner_id, created_by)
       values ($1,'CYC-2026-01','دورة تطوير البنية 2026 — توحيد التراخيص','توحيد خدمات الترخيص على منصة واحدة وتقاعد الأنظمة المتداخلة',
               '{business,data,applications,technology}', '2026-07-01', '2027-03-31', 'active', 'target', $2, $2) returning id`, [ea, owner])).rows[0].id;
    const tasks = [
      ['scope', 'تحديد أهداف الدورة ونطاقها والمجالات المشمولة', 'وثيقة نطاق الدورة', 'done', owner, '2026-07-15'],
      ['scope', 'تحديد أصحاب المصلحة وفريق العمل', 'مصفوفة أصحاب المصلحة', 'done', owner, '2026-07-20'],
      ['baseline', 'تحديث سجلات التطبيقات والتقنية واعتمادها', 'مستودع محدّث ومعتمد', 'done', arch, '2026-08-31'],
      ['baseline', 'مراجعة جودة البيانات واكتمال السمات', 'تقرير جودة البيانات', 'done', arch, '2026-09-15'],
      ['target', 'تصميم الوضع المستهدف لخدمات الترخيص', 'سجل التغييرات المخطط لها', 'doing', arch, '2026-11-30'],
      ['target', 'مواءمة الوضع المستهدف مع هدف رقمنة الخدمات', 'مصفوفة المواءمة', 'todo', owner, '2026-12-15'],
      ['gap', 'تحليل الفجوات وأثر تقاعد نظام إدارة الوثائق', 'تقرير تحليل الفجوات والأثر', 'todo', arch, '2027-01-15'],
      ['roadmap', 'خارطة طريق الانتقال وتقدير التكاليف', 'خارطة الطريق', 'todo', owner, '2027-02-15'],
      ['approval', 'عرض المخرجات على لجنة البنية المؤسسية', 'محضر الاعتماد', 'todo', owner, '2027-03-15'],
    ];
    let sort = 0;
    for (const [phase, title, deliverable, status, who, due] of tasks) await db.query(
      `insert into ea_cycle_tasks (tenant_id, cycle_id, phase, title, deliverable, status, assignee_id, due_date, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ea, cyc, phase, title, deliverable, status, who, due, sort++]);
    for (const [rec, type, why, date] of [
      [lic, 'add', 'منصة موحدة لخدمات الترخيص', '2027-01-31'],
      [dms, 'retire', 'تنتقل وظائفه في مسار الترخيص إلى المنصة الموحدة', '2027-03-31'],
      [portal, 'modify', 'ربط البوابة بالمنصة الموحدة بدلاً من نظام العملاء', '2027-02-28'],
      [sv2, 'modify', 'رفع أتمتة تجديد الترخيص إلى أتمتة كاملة', '2027-02-28'],
    ]) await db.query(`insert into ea_cycle_changes (tenant_id, cycle_id, record_id, change_type, rationale, target_date, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
      [ea, cyc, rec, type, why, date, arch]);
  }

  // A few notifications so the bell has something to show on first sign-in.
  for (const [user, actor, kind, payload] of [
    [owner, arch, 'task_assigned', { title: 'مواءمة الوضع المستهدف مع هدف رقمنة الخدمات', cycle: 'CYC-2026-01', path: '/cycles' }],
    [arch, owner, 'rejected', { name: 'نظام إدارة علاقات العملاء', comment: 'يرجى تحديث مستوى الأهمية وتكلفة التشغيل', record_id: crm, path: `/records/${crm}` }],
  ]) await db.query(`insert into notifications (tenant_id, user_id, kind, payload, actor_id) values ($1,$2,$3,$4,$5)`, [ea, user, kind, JSON.stringify(payload), actor]);

  // A short, realistic history on one record so the change-history tab has something to show.
  {
    const cur = (await db.query('select attrs from records where id=$1', [crm])).rows[0].attrs;
    const v1 = { ...cur, importance: 'متوسطة', operating_cost: 250000 };
    const H = (action, before, after, user, daysAgo) => db.query(
      `insert into audit_log (tenant_id, user_id, action, entity, entity_id, before, after, at) values ($1,$2,$3,'record',$4,$5,$6, now() - ($7 || ' days')::interval)`,
      [ea, user, action, crm, before && JSON.stringify(before), after && JSON.stringify(after), String(daysAgo)]);
    await H('create', null, { attrs: v1, status: 'draft' }, arch, 40);
    await H('submit', { status: 'draft' }, { status: 'submitted' }, arch, 39);
    await H('reject', { status: 'submitted' }, { status: 'rejected', comment: 'يرجى تحديث مستوى الأهمية وتكلفة التشغيل' }, owner, 38);
    await H('update', { attrs: v1 }, { attrs: cur }, arch, 37);
    await H('submit', { status: 'rejected' }, { status: 'submitted' }, arch, 37);
    await H('review', { status: 'submitted' }, { status: 'reviewed' }, owner, 36);
    await H('approve', { status: 'reviewed' }, { status: 'approved' }, owner, 35);
  }

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
