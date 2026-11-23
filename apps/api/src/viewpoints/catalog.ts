/**
 * The 35 phase-1 viewpoints — BRD section 3.3 (from the DGA viewpoints guide).
 * Each one is declarative: the engine builds it from the repository, so a new viewpoint is a new entry here.
 * Viewpoints marked `phase2` rely on blocks that are part of phase 2; they work as soon as the entity activates those blocks.
 */
export type ViewpointSpec =
  | { kind: 'list'; blocks: string[]; columns?: string[] }
  | { kind: 'matrix'; rows: string[]; cols: string[]; via?: string[] }
  | { kind: 'group'; blocks: string[]; by: { attr: string } | { related: string } | { block: true } }
  | { kind: 'nest'; container: string; children: string[] }
  | { kind: 'graph'; blocks: string[]; collapse?: string };

export interface Viewpoint {
  code: string;
  domain: 'applications' | 'technology' | 'security';
  name_ar: string;
  name_en: string;
  purpose_ar: string;
  purpose_en: string;
  phase2?: boolean;
  spec: ViewpointSpec;
}

const COST = ['capital_cost', 'operating_cost'];
const TECH = ['data_center', 'physical_host', 'server', 'network_device', 'network_link', 'storage', 'containerization_engine',
  'infrastructure_management_tool', 'license', 'infrastructure_service', 'peripheral_device'];
const SEC_HW_SW = ['security_hardware', 'security_software'];

const list = (code: string, domain: Viewpoint['domain'], block: string, name_ar: string, name_en: string, columns: string[]): Viewpoint => ({
  code, domain, name_ar, name_en,
  purpose_ar: `حصر ${name_ar.replace('دليل ', '')} بسماتها الأساسية.`,
  purpose_en: `Inventory of ${name_en.replace(' catalogue', '').toLowerCase()} with their key attributes.`,
  spec: { kind: 'list', blocks: [block], columns },
});

const appMatrix = (n: number, col: string, ar: string, en: string, phase2 = false): Viewpoint => ({
  code: `APP-M${n}`, domain: 'applications', phase2,
  name_ar: `مصفوفة التطبيق مع ${ar}`, name_en: `Application / ${en} matrix`,
  purpose_ar: `أي التطبيقات ترتبط بأي ${ar}.`, purpose_en: `Which applications relate to which ${en.toLowerCase()}.`,
  spec: { kind: 'matrix', rows: ['application'], cols: [col] },
});

export const VIEWPOINTS: Viewpoint[] = [
  // ── Applications (15) ──
  list('APP-L1', 'applications', 'application', 'دليل التطبيقات', 'Applications catalogue',
    ['code', 'layer', 'application_status', 'development_type', 'importance', ...COST]),
  list('APP-L2', 'applications', 'technical_integration_interface', 'سجل نقاط الربط التقني', 'Technical integration points register',
    ['code', 'product', 'consumer', 'integration_type', 'connection_pattern', 'data_format']),
  appMatrix(1, 'beneficiary', 'المستفيد', 'Beneficiary', true),
  appMatrix(2, 'organizational_unit', 'الوحدة التنظيمية', 'Organizational unit', true),
  appMatrix(3, 'service', 'خدمة الأعمال', 'Business service', true),
  appMatrix(4, 'business_process', 'إجراء العمل', 'Business process', true),
  appMatrix(5, 'data_entity', 'كيان البيانات', 'Data entity', true),
  appMatrix(6, 'server', 'الخادم', 'Server'),
  appMatrix(7, 'security_software', 'برمجية الأمن', 'Security software'),
  { code: 'APP-D1', domain: 'applications', name_ar: 'المشهد العام للتطبيقات', name_en: 'Application landscape',
    purpose_ar: 'التطبيقات موزعة على طبقات النموذج المرجعي.', purpose_en: 'Applications arranged by reference-model layer.',
    spec: { kind: 'group', blocks: ['application'], by: { attr: 'layer' } } },
  { code: 'APP-D2', domain: 'applications', name_ar: 'المشهد العام لمكونات التطبيقات', name_en: 'Application components landscape',
    purpose_ar: 'كل تطبيق ومكوناته.', purpose_en: 'Each application with its modules.',
    spec: { kind: 'nest', container: 'application', children: ['application_modules'] } },
  { code: 'APP-D3', domain: 'applications', name_ar: 'المشهد العام للتكامل', name_en: 'Integration landscape',
    purpose_ar: 'التطبيقات ونقاط الربط التقني بينها.', purpose_en: 'Applications and the integration interfaces between them.',
    spec: { kind: 'graph', blocks: ['application', 'technical_integration_interface'] } },
  { code: 'APP-D4', domain: 'applications', name_ar: 'منظور تكامل التطبيقات', name_en: 'Application integration view',
    purpose_ar: 'أي تطبيق يتبادل البيانات مع أي تطبيق، عبر نقاط الربط.', purpose_en: 'Which application exchanges data with which, through interfaces.',
    spec: { kind: 'graph', blocks: ['application', 'technical_integration_interface'], collapse: 'technical_integration_interface' } },
  { code: 'APP-D5', domain: 'applications', phase2: true, name_ar: 'التطبيقات حسب الوحدة التنظيمية', name_en: 'Applications by organizational unit',
    purpose_ar: 'التطبيقات مجمّعة حسب الوحدة المالكة.', purpose_en: 'Applications grouped by owning unit.',
    spec: { kind: 'group', blocks: ['application'], by: { related: 'organizational_unit' } } },
  { code: 'APP-D6', domain: 'applications', name_ar: 'التطبيقات حسب نوع التطوير', name_en: 'Applications by development type',
    purpose_ar: 'التطبيقات مجمّعة حسب نوع التطوير.', purpose_en: 'Applications grouped by development type.',
    spec: { kind: 'group', blocks: ['application'], by: { attr: 'development_type' } } },

  // ── Technology (12) ──
  list('TEC-L1', 'technology', 'physical_host', 'دليل أجهزة المضيف المادي', 'Physical hosts catalogue',
    ['manufacturer', 'model', 'cluster_id', 'type_of_virtual_machine_monitor', 'total_number_of_physical_cpu_cores', 'physical_random_access_memory_ram', 'support_end_date']),
  list('TEC-L2', 'technology', 'server', 'دليل الخوادم', 'Servers catalogue',
    ['server_type', 'operating_system_type', 'operating_system_version', 'environment', 'role', 'central_processing_units', 'random_access_memory_ram', 'status']),
  list('TEC-L3', 'technology', 'network_device', 'دليل الأجهزة الشبكية', 'Network devices catalogue',
    ['manufacturer', 'model', 'type', 'function', 'location', 'firmware_version', 'support_end_date']),
  list('TEC-L4', 'technology', 'storage', 'دليل التخزين', 'Storage catalogue',
    ['manufacturer', 'model', 'storage_capacity', 'firmware_version', 'support_end_date']),
  list('TEC-L5', 'technology', 'infrastructure_management_tool', 'دليل أدوات التقنية التحتية', 'Infrastructure management tools catalogue',
    ['manufacturer', 'version', 'function', 'support_end_date']),
  list('TEC-L6', 'technology', 'infrastructure_service', 'دليل خدمات التقنية التحتية', 'Infrastructure services catalogue',
    ['service_code', 'manufacturer', 'version', 'function', 'support_end_date']),
  { code: 'TEC-M1', domain: 'technology', phase2: true, name_ar: 'مصفوفة مركز البيانات مع مزود الخدمة', name_en: 'Data center / Service provider matrix',
    purpose_ar: 'من يقدّم خدمات كل مركز بيانات.', purpose_en: 'Who provides each data center.',
    spec: { kind: 'matrix', rows: ['data_center'], cols: ['service_provider'] } },
  { code: 'TEC-M2', domain: 'technology', name_ar: 'مصفوفة مركز البيانات مع التطبيق', name_en: 'Data center / Application matrix',
    purpose_ar: 'في أي مركز بيانات يعمل كل تطبيق، عبر خوادمه ومضيفاته.', purpose_en: 'Where each application runs, through its servers and hosts.',
    spec: { kind: 'matrix', rows: ['data_center'], cols: ['application'], via: ['server', 'physical_host'] } },
  { code: 'TEC-D1', domain: 'technology', name_ar: 'المشهد العام لتوزع مراكز البيانات', name_en: 'Data center distribution landscape',
    purpose_ar: 'محتوى كل مركز بيانات من مكونات التقنية.', purpose_en: 'What each data center hosts.',
    spec: { kind: 'nest', container: 'data_center', children: ['physical_host', 'server', 'storage', 'network_device', 'containerization_engine', 'security_hardware'] } },
  { code: 'TEC-D2', domain: 'technology', name_ar: 'المخطط العام لبنية الشبكة', name_en: 'Network architecture overview',
    purpose_ar: 'الأجهزة الشبكية والروابط ومراكز البيانات وأجهزة الأمن.', purpose_en: 'Network devices, links, data centers and security devices.',
    spec: { kind: 'graph', blocks: ['data_center', 'network_device', 'network_link', 'security_hardware'] } },
  { code: 'TEC-D3', domain: 'technology', name_ar: 'مخطط دارات الربط الشبكي', name_en: 'Network circuits diagram',
    purpose_ar: 'دارات الربط وما تصله من مواقع وأجهزة.', purpose_en: 'Network circuits and the sites and devices they connect.',
    spec: { kind: 'graph', blocks: ['network_link', 'data_center', 'network_device'] } },
  { code: 'TEC-D4', domain: 'technology', name_ar: 'المشهد العام لقدرات بنية التقنية', name_en: 'Technology capabilities landscape',
    purpose_ar: 'مكونات بنية التقنية حسب نوعها.', purpose_en: 'Technology components by type.',
    spec: { kind: 'group', blocks: TECH, by: { block: true } } },

  // ── Security (8) ──
  list('SEC-L1', 'security', 'security_hardware', 'دليل أجهزة الأمن', 'Security hardware catalogue',
    ['code', 'manufacturer', 'model', 'function', 'network_segment', 'support_end_date']),
  list('SEC-L2', 'security', 'security_software', 'دليل برمجيات الأمن', 'Security software catalogue',
    ['code', 'manufacturer', 'version', 'function', 'support_end_date']),
  list('SEC-L3', 'security', 'security_service', 'دليل خدمات الأمن', 'Security services catalogue',
    ['code', 'function', 'status_of_the_service_provision_contract', 'type_of_operation']),
  { code: 'SEC-M1', domain: 'security', name_ar: 'وظائف أجهزة وبرمجيات الأمن مع أماكن التطبيق', name_en: 'Security functions / Deployment locations',
    purpose_ar: 'أين تعمل كل وظيفة أمنية.', purpose_en: 'Where each security function is deployed.',
    spec: { kind: 'matrix', rows: SEC_HW_SW, cols: ['data_center'] } },
  { code: 'SEC-M2', domain: 'security', name_ar: 'وظائف أجهزة وبرمجيات الأمن مع التطبيقات المرتبطة', name_en: 'Security functions / Protected applications',
    purpose_ar: 'أي التطبيقات تحميها كل وظيفة أمنية.', purpose_en: 'Which applications each security function protects.',
    spec: { kind: 'matrix', rows: SEC_HW_SW, cols: ['application'] } },
  { code: 'SEC-M3', domain: 'security', phase2: true, name_ar: 'مصفوفة خدمة الأمن مع مزود الخدمة', name_en: 'Security service / Service provider matrix',
    purpose_ar: 'من يقدّم كل خدمة أمنية.', purpose_en: 'Who provides each security service.',
    spec: { kind: 'matrix', rows: ['security_service'], cols: ['service_provider'] } },
  { code: 'SEC-D1', domain: 'security', name_ar: 'مخطط توزع أجهزة الأمن في مراكز البيانات', name_en: 'Security devices by data center',
    purpose_ar: 'أجهزة الأمن وبرمجياته في كل مركز بيانات.', purpose_en: 'Security devices and software in each data center.',
    spec: { kind: 'nest', container: 'data_center', children: SEC_HW_SW } },
  { code: 'SEC-D2', domain: 'security', name_ar: 'المشهد العام لقدرات بنية الأمن', name_en: 'Security capabilities landscape',
    purpose_ar: 'مكونات الأمن حسب وظيفتها.', purpose_en: 'Security components by function.',
    spec: { kind: 'group', blocks: [...SEC_HW_SW, 'security_service'], by: { attr: 'function' } } },
];

export function blocksOf(spec: ViewpointSpec): string[] {
  switch (spec.kind) {
    case 'list': case 'graph': return spec.blocks;
    case 'group': return 'related' in spec.by ? [...spec.blocks, spec.by.related] : spec.blocks;
    case 'matrix': return [...spec.rows, ...spec.cols, ...(spec.via ?? [])];
    case 'nest': return [spec.container, ...spec.children];
  }
}
