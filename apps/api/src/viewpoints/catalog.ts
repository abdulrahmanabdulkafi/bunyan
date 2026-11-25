/**
 * The 35 phase-1 viewpoints — BRD section 3.3 (from the DGA viewpoints guide) — plus the core viewpoints of the
 * strategy, business, beneficiary and data domains, so every domain of the national meta-model can be seen.
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
  domain: 'strategy' | 'business' | 'beneficiary' | 'data' | 'applications' | 'technology' | 'security';
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

  // ── Strategic alignment (6) ──
  list('STR-L1', 'strategy', 'objective', 'دليل الأهداف', 'Objectives catalogue', ['code', 'type', 'description']),
  list('STR-L2', 'strategy', 'initiative', 'دليل المبادرات', 'Initiatives catalogue',
    ['code', 'type', 'owner_of_the_initiative', 'start_date', 'completion_date', 'budget']),
  list('STR-L3', 'strategy', 'key_performance_indicator', 'دليل مؤشرات الأداء', 'Key performance indicators catalogue',
    ['code', 'indicator_level', 'measurement_unit', 'measurement_periodicity', 'baseline_value', 'target_value', 'actual_indicator_value']),
  { code: 'STR-M1', domain: 'strategy', name_ar: 'مصفوفة الأهداف مع المبادرات', name_en: 'Objective / Initiative matrix',
    purpose_ar: 'أي المبادرات تحقق أي الأهداف.', purpose_en: 'Which initiatives deliver which objectives.',
    spec: { kind: 'matrix', rows: ['objective'], cols: ['initiative'] } },
  { code: 'STR-M2', domain: 'strategy', name_ar: 'مصفوفة المبادرات مع الوحدات التنظيمية', name_en: 'Initiative / Organizational unit matrix',
    purpose_ar: 'أي الوحدات التنظيمية مسؤولة عن أي المبادرات.', purpose_en: 'Which organizational units own which initiatives.',
    spec: { kind: 'matrix', rows: ['initiative'], cols: ['organizational_unit'] } },
  { code: 'STR-D1', domain: 'strategy', name_ar: 'خريطة التوجه الاستراتيجي', name_en: 'Strategy map',
    purpose_ar: 'الرؤية والرسالة والركائز والأهداف والمبادرات والمشاريع وصلاتها.', purpose_en: 'Vision, mission, pillars, objectives, initiatives and projects, and how they connect.',
    spec: { kind: 'graph', blocks: ['vision', 'mission', 'pillar', 'objective', 'initiative', 'project'] } },
  { code: 'STR-D2', domain: 'strategy', name_ar: 'المشاريع حسب المبادرة', name_en: 'Projects by initiative',
    purpose_ar: 'المشاريع مجمّعة حسب المبادرة التي تنفذها.', purpose_en: 'Projects grouped by the initiative they deliver.',
    spec: { kind: 'group', blocks: ['project'], by: { related: 'initiative' } } },

  // ── Business (6) ──
  list('BUS-L1', 'business', 'service', 'دليل الخدمات', 'Services catalogue',
    ['code', 'service_type', 'classification', 'automation_level', 'type_of_beneficiary', 'geographic_coverage']),
  list('BUS-L2', 'business', 'business_capability', 'دليل قدرات الأعمال', 'Business capabilities catalogue',
    ['capability_type', 'capability_maturity_level', 'description']),
  { code: 'BUS-M1', domain: 'business', name_ar: 'مصفوفة الخدمات مع إجراءات العمل', name_en: 'Service / Business process matrix',
    purpose_ar: 'أي إجراءات العمل تقدّم كل خدمة.', purpose_en: 'Which business processes deliver each service.',
    spec: { kind: 'matrix', rows: ['service'], cols: ['business_process'] } },
  { code: 'BUS-M2', domain: 'business', name_ar: 'مصفوفة قدرات الأعمال مع الوحدات التنظيمية', name_en: 'Business capability / Organizational unit matrix',
    purpose_ar: 'أي الوحدات التنظيمية تملك كل قدرة.', purpose_en: 'Which organizational units hold each capability.',
    spec: { kind: 'matrix', rows: ['business_capability'], cols: ['organizational_unit'] } },
  { code: 'BUS-D1', domain: 'business', name_ar: 'خريطة قدرات الأعمال', name_en: 'Business capability map',
    purpose_ar: 'قدرات الأعمال مجمّعة حسب نوعها.', purpose_en: 'Business capabilities grouped by type.',
    spec: { kind: 'group', blocks: ['business_capability'], by: { attr: 'capability_type' } } },
  { code: 'BUS-D2', domain: 'business', name_ar: 'هيكل مجموعات الإجراءات', name_en: 'Process groups structure',
    purpose_ar: 'كل مجموعة إجراءات وما تحتويه من إجراءات عمل.', purpose_en: 'Each process group and the business processes in it.',
    spec: { kind: 'nest', container: 'processes_group', children: ['business_process'] } },

  // ── Beneficiary experience (4) ──
  list('BEN-L1', 'beneficiary', 'beneficiary', 'دليل المستفيدين', 'Beneficiaries catalogue', ['type', 'description']),
  { code: 'BEN-M1', domain: 'beneficiary', name_ar: 'مصفوفة المستفيدين مع الخدمات', name_en: 'Beneficiary / Service matrix',
    purpose_ar: 'أي الخدمات يستفيد منها كل مستفيد.', purpose_en: 'Which services each beneficiary uses.',
    spec: { kind: 'matrix', rows: ['beneficiary'], cols: ['service'] } },
  { code: 'BEN-D1', domain: 'beneficiary', name_ar: 'رحلات المستفيد ومراحلها', name_en: 'Beneficiary journeys and phases',
    purpose_ar: 'كل رحلة مستفيد ومراحلها.', purpose_en: 'Each beneficiary journey and its phases.',
    spec: { kind: 'nest', container: 'beneficiary_journey', children: ['phase'] } },
  { code: 'BEN-D2', domain: 'beneficiary', name_ar: 'مخطط تجربة المستفيد', name_en: 'Beneficiary experience map',
    purpose_ar: 'الشخصيات والرحلات والمراحل والخطوات وصلاتها.', purpose_en: 'Personas, journeys, phases and steps, and how they connect.',
    spec: { kind: 'graph', blocks: ['persona', 'beneficiary_journey', 'phase', 'step'] } },

  // ── Data (6) ──
  list('DAT-L1', 'data', 'data_entity', 'دليل كيانات البيانات', 'Data entities catalogue',
    ['code', 'data_entity_classification', 'storage_classification', 'structure_classification', 'data_source']),
  { code: 'DAT-M1', domain: 'data', name_ar: 'مصفوفة كيانات البيانات مع التطبيقات', name_en: 'Data entity / Application matrix',
    purpose_ar: 'أي التطبيقات تستخدم كل كيان بيانات.', purpose_en: 'Which applications use each data entity.',
    spec: { kind: 'matrix', rows: ['data_entity'], cols: ['application'] } },
  { code: 'DAT-M2', domain: 'data', name_ar: 'مصفوفة كيانات البيانات مع الوحدات التنظيمية', name_en: 'Data entity / Organizational unit matrix',
    purpose_ar: 'أي الوحدات التنظيمية تملك كل كيان بيانات.', purpose_en: 'Which organizational units own each data entity.',
    spec: { kind: 'matrix', rows: ['data_entity'], cols: ['organizational_unit'] } },
  { code: 'DAT-D1', domain: 'data', name_ar: 'كيانات البيانات حسب التصنيف', name_en: 'Data entities by classification',
    purpose_ar: 'كيانات البيانات مجمّعة حسب مستوى تصنيفها.', purpose_en: 'Data entities grouped by classification level.',
    spec: { kind: 'group', blocks: ['data_entity'], by: { attr: 'data_entity_classification' } } },
  { code: 'DAT-D2', domain: 'data', name_ar: 'مستودعات البيانات ومحتواها', name_en: 'Data vaults and their contents',
    purpose_ar: 'كل مستودع بيانات وما يحفظه من كيانات.', purpose_en: 'Each data vault and the data entities it stores.',
    spec: { kind: 'nest', container: 'data_vault', children: ['data_entity'] } },
  { code: 'DAT-D3', domain: 'data', name_ar: 'كيانات البيانات وسماتها', name_en: 'Data entities and their attributes',
    purpose_ar: 'كل كيان بيانات وسماته.', purpose_en: 'Each data entity with its attributes.',
    spec: { kind: 'nest', container: 'data_entity', children: ['data_attributes'] } },
];

export function blocksOf(spec: ViewpointSpec): string[] {
  switch (spec.kind) {
    case 'list': case 'graph': return spec.blocks;
    case 'group': return 'related' in spec.by ? [...spec.blocks, spec.by.related] : spec.blocks;
    case 'matrix': return [...spec.rows, ...spec.cols, ...(spec.via ?? [])];
    case 'nest': return [spec.container, ...spec.children];
  }
}
