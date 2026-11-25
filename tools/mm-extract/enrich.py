"""Enrich packages/seed/metamodel.seed.json from the DGA "EA Content Meta Model" guide (v1.0, Dec 2024).

1. Predefined lists: the guide gives example values in each attribute's description ("e.g.: …").
   They become suggested options with Arabic and English labels (lists stay open unless an entity makes them strict).
2. Connections: corrections found by tools/mm-extract/relations.py, checked against both the English and the
   Arabic edition of the guide (beneficiary experience table rows 4, 6 and 9; service row 26; security hardware row 1).
3. All seven domains and their building blocks are active by default.

Run: python3 tools/mm-extract/enrich.py packages/seed/metamodel.seed.json
"""
import json, sys

path = sys.argv[1]
seed = json.load(open(path, encoding='utf-8'))

# label_en → label_ar, shared by many attributes
AR = {
    'active': 'نشط', 'inactive': 'غير نشط', 'expired': 'منتهٍ',
    'in-house team': 'فريق داخلي', 'service provider': 'مقدم خدمة', 'other': 'أخرى',
    'core': 'أساسي', 'administrative': 'إداري', 'supporting': 'مساند',
    'fully automated': 'مؤتمت بالكامل', 'partially automated': 'مؤتمت جزئياً', 'manual': 'يدوي',
    'government entity': 'جهة حكومية', 'private sector': 'قطاع خاص', 'individual': 'فرد',
    'internal': 'داخلي', 'external': 'خارجي',
    'strategic': 'استراتيجي', 'operational': 'تشغيلي',
    'high': 'عالية', 'medium': 'متوسطة', 'low': 'منخفضة', 'critical': 'حرجة',
    'yes': 'نعم', 'no': 'لا', 'partially': 'جزئياً', 'not applicable': 'لا ينطبق',
    'production environment': 'بيئة الإنتاج', 'testing environment': 'بيئة الاختبار',
    'preproduction environment': 'بيئة ما قبل الإنتاج', 'experimental environment': 'بيئة تجريبية',
    'data center': 'مركز البيانات', 'data center server farm': 'مزرعة خوادم مركز البيانات',
}
NET = ['DMZ', 'Extranet', 'Internet', 'WAN', 'LAN', 'Air Gapped', 'data center']
NET_AR = {'DMZ': 'المنطقة المنزوعة (DMZ)', 'Extranet': 'الشبكة الخارجية (Extranet)', 'Internet': 'الإنترنت', 'WAN': 'الشبكة الواسعة (WAN)',
          'LAN': 'الشبكة المحلية (LAN)', 'Air Gapped': 'شبكة معزولة (Air Gapped)', 'data center': 'مركز البيانات'}
SUPPORT = ['active', 'expired']
OPS2 = ['in-house team', 'service provider']
OPS3 = ['in-house team', 'service provider', 'other']

# (block, attribute) → list of (label_en, label_ar or None to use AR)
LISTS = {
    ('initiative', 'type'): [('Strategic initiative', 'مبادرة استراتيجية'), ('Technical initiative', 'مبادرة تقنية'), ('Operational initiative', 'مبادرة تشغيلية')],
    ('project', 'status_of_the_project'): [('Scheduled', 'مجدول'), ('Active', 'نشط'), ('Suspended', 'معلّق'), ('Cancelled', 'ملغى'), ('Completed', 'مكتمل')],
    ('project', 'entity_in_charge_of_execution'): [('In-house execution', 'تنفيذ داخلي'), ('Outsourced execution', 'تنفيذ خارجي')],
    ('project', 'currency'): [('Saudi Riyal', 'ريال سعودي'), ('US Dollar', 'دولار أمريكي')],
    ('project', 'priority'): [('High priority', 'أولوية عالية'), ('Medium priority', 'أولوية متوسطة'), ('Low priority', 'أولوية منخفضة')],
    ('key_performance_indicator', 'indicator_level'): [('Strategic', 'استراتيجي'), ('Operational', 'تشغيلي')],
    ('key_performance_indicator', 'measurement_periodicity'): [('Daily', 'يومي'), ('Monthly', 'شهري'), ('Quarterly', 'ربع سنوي'), ('Semi-annual', 'نصف سنوي'), ('Annual', 'سنوي')],
    ('key_performance_indicator', 'measurement_unit'): [('Percentage', 'نسبة مئوية'), ('Number', 'عدد')],
    ('key_performance_indicator', 'polarity_of_measurement'): [('Ascending', 'تصاعدي'), ('Descending', 'تنازلي')],
    ('business_capability', 'capability_type'): [('Strategic', 'استراتيجية'), ('Operational', 'تشغيلية'), ('Supporting', 'مساندة')],
    ('business_capability', 'capability_maturity_level'): [('High maturity capability', 'قدرة عالية النضج'), ('Medium maturity capability', 'قدرة متوسطة النضج'), ('Low maturity capability', 'قدرة منخفضة النضج')],
    ('service_provider', 'type_of_contractual_relationship'): [('External partner', 'شريك خارجي'), ('Authorized service provider', 'مقدم خدمة معتمد'), ('Service provider', 'مقدم خدمة'),
        ('Technical solutions and hardware provider', 'مورد حلول وأجهزة تقنية'), ('Security solutions and hardware provider', 'مورد حلول وأجهزة أمنية')],
    ('service_provider', 'service_provider_status'): [('Active', 'نشط'), ('Inactive', 'غير نشط')],
    ('service_provider', 'field_of_activity'): [('Technology solutions', 'حلول تقنية'), ('Security solutions', 'حلول أمنية'), ('Hardware provider', 'مورد أجهزة'), ('Service provider', 'مقدم خدمات')],
    ('service', 'classification'): [('Core service', 'خدمة رئيسية'), ('Sub-service', 'خدمة فرعية')],
    ('service', 'service_type'): [('Core', 'أساسية'), ('Administrative', 'إدارية'), ('Supporting', 'مساندة')],
    ('service', 'geographic_coverage'): [('Within specific areas', 'مناطق محددة'), ('All areas of the Kingdom', 'جميع مناطق المملكة'), ('Inside and outside the Kingdom', 'داخل المملكة وخارجها')],
    ('service', 'automation_level'): [('Fully automated', None), ('Partially automated', None), ('Manual', None)],
    ('service', 'type_of_beneficiary'): [('Government entity', None), ('Private sector', None), ('Individual', 'أفراد')],
    ('service', 'service_status'): [('Active', 'نشطة'), ('Inactive', 'غير نشطة')],
    ('processes_group', 'type'): [('Core', 'أساسية'), ('Administrative', 'إدارية'), ('Supporting', 'مساندة')],
    ('business_process', 'process_classification'): [('Core process', 'إجراء رئيسي'), ('Sub-process', 'إجراء فرعي')],
    ('business_process', 'type'): [('Core', 'أساسي'), ('Administrative', 'إداري'), ('Supporting', 'مساند')],
    ('business_process', 'type_of_beneficiary'): [('Government entity', None), ('Private sector', None), ('Individual', 'أفراد')],
    ('business_process', 'automation_level'): [('Fully automated', None), ('Partially automated', None), ('Manual', None)],
    ('activity', 'automation_level'): [('Fully automated', None), ('Partially automated', None), ('Manual', None)],
    ('product', 'product_type'): [('Physical product', 'منتج مادي'), ('Technical product', 'منتج تقني'), ('Document', 'وثيقة')],
    ('role', 'role_type'): [('Core role', 'دور أساسي'), ('Supporting role', 'دور مساند')],
    ('policy', 'type'): [('Internal', 'داخلية'), ('External (governmental)', 'خارجية (حكومية)')],
    ('policy', 'status'): [('Activated', 'مفعّلة'), ('Suspended', 'معلّقة'), ('Cancelled', 'ملغاة')],
    ('model_template', 'type'): [('Service delivery template', 'نموذج تقديم خدمة'), ('Data collection template', 'نموذج جمع بيانات'), ('Guide template', 'نموذج دليل'), ('Policy template', 'نموذج سياسة')],
    ('beneficiary', 'type'): [('Internal beneficiary', 'مستفيد داخلي'), ('Government entity', 'جهة حكومية'), ('Business sector', 'قطاع الأعمال'), ('Individuals', 'أفراد')],
    ('step', 'communication_channel'): [('Digital platforms', 'المنصات الرقمية'), ('Smartphone apps', 'تطبيقات الهواتف الذكية'), ('Social media platforms', 'منصات التواصل الاجتماعي'),
        ('E-mail', 'البريد الإلكتروني'), ('Field visits', 'الزيارات الميدانية'), ('Telephone calls', 'الاتصالات الهاتفية')],
    ('application', 'development_source'): [('Internal', None), ('External', None)],
    ('application', 'importance'): [('Critical', None), ('High', None), ('Medium', None), ('Low', None)],
    ('application', 'application_status'): [('Planned', 'مخطط'), ('Under development', 'قيد التطوير'), ('Newly launched', 'حديث الإطلاق'), ('Active', 'قيد التشغيل'), ('Locked', 'موقوف'), ('Retired', 'متقاعد')],
    ('application', 'pattern_of_the_architecture_structure'): [('N-tier architecture', 'متعدد الطبقات (N-tier)'), ('Client/server', 'خادم/عميل'), ('Microservices', 'خدمات مصغّرة'), ('Monolithic', 'متجانس (Monolithic)')],
    ('application', 'technology_used_for_development'): [('Oracle', 'Oracle'), ('Microsoft', 'Microsoft'), ('Java', 'Java'), ('.NET', '.NET'), ('Low-code platform', 'منصة تطوير منخفض الكود')],
    ('technical_integration_interface', 'scope_of_the_connection'): [('Internal', None), ('External', None)],
    ('technical_integration_interface', 'connection_pattern'): [('Direct connection', 'اتصال مباشر'), ('Via the integration platform', 'عبر منصة التكامل'),
        ('Secure government network', 'الشبكة الحكومية الآمنة'), ('Government Service Bus (GSB)', 'قناة التكامل الحكومية (GSB)')],
    ('technical_integration_interface', 'integration_type'): [('DB Link', 'DB Link'), ('SFTP', 'SFTP'), ('SOAP', 'SOAP'), ('REST', 'REST')],
    ('technical_integration_interface', 'data_format'): [('XML', 'XML'), ('JSON', 'JSON'), ('Text', 'نص'), ('CSV', 'CSV')],
    ('data_center', 'role'): [('Primary data center', 'مركز البيانات الرئيسي'), ('Disaster recovery center', 'مركز التعافي من الكوارث')],
    ('data_center', 'classification_level'): [('Level 1', 'المستوى 1'), ('Level 2', 'المستوى 2'), ('Level 3', 'المستوى 3'), ('Level 4', 'المستوى 4')],
    ('data_center', 'environment'): [('Production environment', None), ('Experimental environment', None), ('Testing environment', None)],
    ('data_center', 'type_of_operation'): [(x, None) for x in OPS2],
    ('physical_host', 'technology'): [('Stand-alone', 'مستقل'), ('Racked server', 'خادم رف'), ('Blade server', 'خادم شفرة (Blade)'), ('Hyper-Converged Infrastructure', 'بنية فائقة التقارب (HCI)')],
    ('physical_host', 'type_of_virtual_machine_monitor'): [('ESXi', 'ESXi'), ('Hyper-V', 'Hyper-V'), ('KVM', 'KVM')],
    ('physical_host', 'network_segment'): [(x, None) for x in NET + ['data center server farm']],
    ('physical_host', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('physical_host', 'type_of_operation'): [(x, None) for x in OPS2],
    ('server', 'operating_system_type'): [('Windows', 'Windows'), ('Linux', 'Linux'), ('Unix', 'Unix')],
    ('server', 'operating_system_version'): [('Windows Server 2022', 'Windows Server 2022'), ('Windows Server 2019', 'Windows Server 2019'), ('Red Hat Enterprise Linux 9', 'Red Hat Enterprise Linux 9'), ('Red Hat Enterprise Linux 8', 'Red Hat Enterprise Linux 8')],
    ('server', 'network_segment'): [(x, None) for x in NET + ['data center server farm']],
    ('server', 'role'): [('Web server', 'خادم ويب'), ('Application server', 'خادم تطبيقات'), ('Database server', 'خادم قواعد بيانات'), ('Integration server', 'خادم تكامل'),
        ('Infrastructure server', 'خادم بنية تحتية'), ('Security server', 'خادم أمني')],
    ('server', 'environment'): [('Production environment', None), ('Preproduction environment', None), ('Testing environment', None)],
    ('server', 'backup'): [(x, None) for x in ['yes', 'no', 'partially', 'not applicable']],
    ('server', 'disaster_recovery'): [(x, None) for x in ['yes', 'no', 'not applicable']],
    ('server', 'status'): [('Operational', 'قيد التشغيل'), ('Not operational', 'متوقف')],
    ('server', 'type_of_operation'): [(x, None) for x in OPS3],
    ('network_device', 'network_segment'): [(x, None) for x in NET],
    ('network_device', 'type'): [('Router', 'موجّه (Router)'), ('Switch', 'مبدّل (Switch)'), ('Access point', 'نقطة وصول'), ('Controller', 'وحدة تحكم')],
    ('network_device', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('network_device', 'type_of_operation'): [(x, None) for x in OPS2],
    ('network_link', 'service'): [(x, x) for x in ['Internet DIA', 'MPLS', 'PLL', 'IPsec tunnel', '5G', 'DWDM', 'IP VPN', 'SIP']],
    ('network_link', 'role'): [('Primary link', 'رابط رئيسي'), ('Backup link', 'رابط احتياطي')],
    ('network_link', 'type_of_operation'): [(x, None) for x in OPS3],
    ('storage', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('storage', 'type_of_operation'): [(x, None) for x in OPS3],
    ('containerization_engine', 'network_segment'): [(x, None) for x in NET],
    ('containerization_engine', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('containerization_engine', 'type_of_operation'): [(x, None) for x in OPS3],
    ('infrastructure_management_tool', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('infrastructure_management_tool', 'type_of_operation'): [(x, None) for x in OPS3],
    ('infrastructure_service', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('infrastructure_service', 'type_of_operation'): [(x, None) for x in OPS2],
    ('peripheral_device', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('peripheral_device', 'type_of_operation'): [(x, None) for x in OPS2],
    ('security_hardware', 'network_segment'): [(x, None) for x in NET],
    ('security_hardware', 'function'): [('Internet firewall', 'جدار حماية الإنترنت'), ('WAN firewall', 'جدار حماية الشبكة الواسعة'), ('Data center firewall', 'جدار حماية مركز البيانات'),
        ('WAF', 'جدار حماية تطبيقات الويب (WAF)'), ('IPS', 'نظام منع التسلل (IPS)'), ('IDS', 'نظام كشف التسلل (IDS)')],
    ('security_hardware', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('security_hardware', 'type_of_operation'): [(x, None) for x in OPS3],
    ('security_software', 'function'): [('DLP', 'منع تسرب البيانات (DLP)'), ('IAM', 'إدارة الهويات والصلاحيات (IAM)'), ('PAM', 'إدارة الصلاحيات الهامة (PAM)'),
        ('SIEM', 'إدارة السجلات والأحداث الأمنية (SIEM)'), ('Vulnerability management', 'إدارة الثغرات'), ('Endpoint protection', 'حماية الأجهزة الطرفية')],
    ('security_software', 'support_contract_status'): [(x, None) for x in SUPPORT],
    ('security_software', 'type_of_operation'): [(x, None) for x in OPS3],
    ('security_service', 'status_of_the_service_provision_contract'): [(x, None) for x in SUPPORT],
    ('security_service', 'type_of_operation'): [(x, None) for x in OPS3],
    ('organizational_unit', 'type'): [('Ministry', 'وزارة'), ('Authority', 'هيئة'), ('Agency', 'وكالة'), ('Sector', 'قطاع'), ('Public administration', 'إدارة عامة'), ('Department', 'إدارة')],
    ('application', 'layer'): [('Access layer', 'طبقة الوصول'), ('Core business applications layer', 'طبقة تطبيقات الأعمال الأساسية'), ('Supporting applications layer', 'طبقة التطبيقات المساندة'),
        ('Data applications layer', 'طبقة تطبيقات البيانات'), ('Infrastructure applications layer', 'طبقة تطبيقات البنية التحتية'), ('Integration applications layer', 'طبقة تطبيقات التكامل'),
        ('Information security applications layer', 'طبقة تطبيقات أمن المعلومات')],
    ('application', 'development_type'): [('Commercial off-the-shelf', 'منتج تجاري جاهز'), ('Custom source code', 'شفرة مصدرية خاصة'), ('Open-source code', 'شفرة مفتوحة المصدر')],
    ('server', 'server_type'): [('Physical server', 'خادم مادي'), ('Virtual server', 'خادم افتراضي')],
    ('network_link', 'technology'): [('Fiber', 'ألياف ضوئية'), ('Copper', 'نحاس'), ('Microwave', 'موجات دقيقة'), ('Satellite', 'أقمار صناعية')],
    ('storage', 'network_segment'): [(x, None) for x in NET],
    ('containerization_engine', 'environment'): [('Production environment', None), ('Development environment', 'بيئة التطوير'), ('Testing environment', None)],
    ('license', 'type'): [('Permanent license', 'ترخيص دائم'), ('Annual subscription', 'اشتراك سنوي'), ('Monthly subscription', 'اشتراك شهري'), ('Open source', 'مفتوح المصدر')],
    ('infrastructure_service', 'function'): [('DNS', 'DNS'), ('DHCP', 'DHCP'), ('NTP', 'NTP'), ('Directory service', 'خدمة الدليل'), ('Email service', 'خدمة البريد الإلكتروني'),
        ('Communication service', 'خدمة الاتصالات'), ('Collaboration service', 'خدمة التعاون'), ('Backup and restore service', 'خدمة النسخ الاحتياطي والاستعادة')],
    ('peripheral_device', 'function'): [('Laptop', 'حاسب محمول'), ('Desktop', 'حاسب مكتبي'), ('Printer', 'طابعة'), ('Sensor', 'مستشعر'), ('Scanner', 'ماسح ضوئي')],
    ('data_entity', 'storage_classification'): [('Inside the Kingdom only', 'داخل المملكة فقط'), ('May be stored outside the Kingdom', 'يجوز تخزينها خارج المملكة')],
    ('service_provider', 'compliance_and_certifications'): [('ISO certification', 'شهادة ISO'), ('Industry-specific certification', 'شهادة قطاعية'), ('NCA compliance', 'الامتثال لضوابط الهيئة الوطنية للأمن السيبراني')],
    # lists already in the seed: add the Arabic labels
    ('data_entity', 'structure_classification'): [('Structured', 'مهيكلة'), ('Semi-structured', 'شبه مهيكلة'), ('Unstructured', 'غير مهيكلة')],
    ('data_entity', 'data_entity_classification'): [('Top Secret', 'سري للغاية'), ('Secret', 'سري'), ('Restricted', 'مقيد'), ('Public', 'عام')],
    ('data_attributes', 'classification'): [('Top Secret', 'سري للغاية'), ('Secret', 'سري'), ('Restricted', 'مقيد'), ('Public', 'عام')],
    ('data_vault', 'type'): None,  # keep values, add Arabic below
    ('data_attributes', 'type'): None,
}
EXTRA_AR = {'Electronic database': 'قاعدة بيانات إلكترونية', 'Digital archive': 'أرشيف رقمي', 'Paper archive': 'أرشيف ورقي',
            'Number': 'رقم', 'Text': 'نص', 'Image': 'صورة', 'Date': 'تاريخ', 'File': 'ملف', 'Audio': 'صوت', 'Video': 'فيديو', 'Boolean': 'منطقي'}

def ar(en):
    return AR.get(en) or AR.get(en.lower()) or NET_AR.get(en) or EXTRA_AR.get(en)

blocks = {b['code']: b for b in seed['blocks']}
filled = 0
for (bc, key), opts in LISTS.items():
    a = next(x for x in blocks[bc]['attributes'] if x['key'] == key)
    if opts is None:
        for o in a['options']:
            o['label_ar'] = o.get('label_ar') or ar(o['value']) or o['value']
        continue
    new = []
    for en, la in opts:
        label_en = en[0].upper() + en[1:] if en[0].islower() and en not in NET else en
        label_ar = la or ar(en)
        assert label_ar, (bc, key, en)
        new.append({'value': label_en, 'label_ar': label_ar, 'label_en': label_en})
    a['options'] = new
    a['type'] = 'enum'
    filled += 1

# Attribute descriptions whose table cells ran together (or were empty) in the first extraction, re-read from the guide.
DESC = {
    ('organizational_unit', 'type'): 'Determining the administrative type that the organizational unit represents (e.g.: ministry, authority, agency, sector, public administration, department)',
    ('organizational_unit', 'organizational_dependency'): 'Organizational affiliation with the highest organizational unit in the entity’s organizational structure',
    ('service_provider', 'type_of_contractual_relationship'): 'Specifying the type of contractual relationship (e.g.: external partner, authorized service provider, service provider, technical solutions and hardware provider, security solutions and hardware provider, etc.)',
    ('service_provider', 'description'): 'Description of the service provider’s objective and scope of work',
    ('storage', 'storage_capacity'): 'Specifying the storage capacity provided by the storage device (in GB)',
    ('service_provider', 'services_provided'): 'Listing of all services provided by the provider to the entity',
    ('service_provider', 'service_provider_status'): 'Determining the status of interaction with the service provider (e.g.: active, inactive)',
    ('service_provider', 'compliance_and_certifications'): 'Shows the status of compliance with legal and regulatory requirements, as well as adherence to regulatory policies and standards. It also shows any certifications or accreditation that the provider holds (e.g.: ISO certification, industry-specific certifications, and compliance certifications)',
    ('service_provider', 'field_of_activity'): 'Defines the provider’s specialization classification (e.g.: technology solutions, security solutions, hardware provider, or service provider)',
    ('service_provider', 'relationship_status'): 'Expresses observations about the nature and status of relationships with the supplier, including strategic partnerships and previous dealings',
    ('step', 'communication_channel'): 'Communication channels associated with each step (e.g.: digital platforms, smartphone apps, social media platforms, traditional channels such as e-mail, field visits, telephone calls)',
    ('data_entity', 'code'): 'Approved code for the data entity',
    ('data_entity', 'name'): 'Common name for the data entity',
    ('data_entity', 'description'): 'Textual description of the data entity',
    ('data_entity', 'key_internal_beneficiaries'): 'Identifying the organizational units and applications that benefit from the data entity within the entity, whether as an application or as an organizational unit',
    ('data_entity', 'key_external_consumers'): 'Identifying the key beneficiaries of the data entity outside the entity, whether as an application or an external party',
    ('data_entity', 'data_source'): 'Name of the data source from which the core data entity is created',
    ('data_entity', 'storage_classification'): 'Classification for defining the parameters of the data entity storage location (possibility of storing data outside the Kingdom)',
    ('data_entity', 'structure_classification'): 'Classification of data entities according to their storage structure (structured, semi-structured, unstructured data)',
    ('data_entity', 'data_business_rules'): 'Defining business rules associated with the use of the data entity',
    ('data_entity', 'security_controls'): 'Determining security measures and controls in line with the entity’s approved controls (e.g. data encryption, data obfuscation)',
    ('data_entity', 'data_storage_rules'): 'Determining the rules regarding the duration of data storage according to the requirements of the controls for data storage and recovery at the entity',
    ('data_entity', 'data_entity_classification'): 'Classification for defining the use of a data entity according to the policies of the National Data Management Office (strictly confidential, confidential, restricted, public)',
    ('data_vault', 'code'): 'Approved code for the data vault',
    ('data_vault', 'name'): 'Name of data vault',
    ('data_vault', 'description'): 'Description of the structure and functions of the data vault',
    ('data_vault', 'type'): 'Specifying the data vault type (e.g.: electronic database, digital archive, paper archive)',
    ('data_vault', 'structure'): 'Specifying the structure type of data entities stored in the data vault',
    ('data_attributes', 'name'): 'Data attribute name',
    ('data_attributes', 'description'): 'Data attribute description',
    ('data_attributes', 'type'): 'Specifying the data attribute type according to the main database design specifications (e.g.: numbers, text, image, date)',
    ('data_attributes', 'quality_rules'): 'Identifying and defining quality rules for data attribute values such as (mandatory value, custom field length, field type) and other custom rules (e.g.: the value must not exceed a certain number, and the date must not be in the past)',
    ('data_attributes', 'classification'): 'Classification according to the data policy and the level of confidentiality of the data entity attributes according to the classification of the Data Management and Governance Policy and in accordance with the level of impact resulting from accessing the data (strictly confidential, confidential, restricted, public)',
    ('application', 'name'): 'The name of the application that is commonly known and used at the entity',
    ('application', 'description'): 'Description of the objectives and nature of the functions provided by the application',
    ('application', 'layer'): 'Determining the layer to which the application belongs (access layer, core business applications layer, supporting applications layer, data applications layer, infrastructure applications layer, integration applications layer, and information security applications layer)',
    ('application', 'development_source'): 'Identifying the source of application development (internal, external)',
    ('application', 'development_type'): 'Determining the type of application development (e.g.: commercial off-the-shelf source code, custom source code, open-source code)',
    ('application', 'application_link'): 'Web address of the browser for accessing the application. It is preceded by protocol identification',
    ('application', 'importance'): 'Determining the importance of the application to the entity’s operational priorities (e.g.: critical, high, medium, low)',
    ('application', 'access_channel'): 'Specifying the digital channel for providing access to the application (e.g.: internal portal, external portal, mobile app)',
    ('application_modules', 'name'): 'Name of a software module in an application that performs a unique function or a set of related functions within the application',
    ('application_modules', 'description'): 'Brief description of the application module, explaining the purpose and nature of the provided function',
    ('technical_integration_interface', 'code'): 'Approved code for the technical integration point. It is used as an identifier to distinguish various types of technical points (e.g.: internal integration points versus external integration points) through a specific numerical sequence that makes them easy to access and search for',
    ('technical_integration_interface', 'name'): 'Name of the technical integration point. It refers to the definition and specification of its objective',
    ('technical_integration_interface', 'consumer'): 'Specifying the names of the applications or entities (in the case of external link) used for the technical integration point',
    ('technical_integration_interface', 'product'): 'Specifying the name of the entity producing the technical integration point',
    ('technical_integration_interface', 'inputs'): 'Determining the inputs of the interface link',
    ('technical_integration_interface', 'connection_pattern'): 'Specifying the type of application interface connection (e.g.: direct connection, via the integration platform, secure government network, the Governmental Service Bus (GSB))',
    ('network_link', 'bandwidth'): 'Specifying the bandwidth of the network link (Mbps)',
    ('network_link', 'service'): 'Determining the service provided by this network link (e.g.: Internet DIA, MPLS, PLL, IP Sec Tunnel, 5G, DWDM, IP VPN, SIP)',
    ('network_link', 'role'): 'Determining the role of the network link (e.g.: primary link, backup link)',
    ('network_link', 'capital_cost'): 'Determining the capital cost of the network link upon installation, which includes: cost of the network link and professional services required for installation and configuration, if any',
    ('network_link', 'operating_cost'): 'Determining the annual operating cost of the network link (where applicable)',
    ('storage', 'network_segment'): 'Determining the network segment to which this storage device belongs (e.g.: DMZ, Extranet, Internet, WAN, LAN, Air Gapped, data center)',
    ('storage', 'capital_cost'): 'Determining the capital cost of the storage device upon installation, which includes: cost of the storage device and professional services required for installation and configuration, if any',
    ('storage', 'operating_cost'): 'Determining the annual operating cost of the storage device (where applicable)',
    ('containerization_engine', 'environment'): 'Determining the hosting environment for the containerization engine (e.g.: production environment, development environment, testing environment)',
    ('containerization_engine', 'support_end_date'): 'Containerization engine support end date as per the manufacturer',
    ('containerization_engine', 'support_contract_status'): 'Determining the status of the support contract for the containerization engine (active, expired)',
    ('containerization_engine', 'capital_cost'): 'Determining the capital cost of the containerization engine upon installation, which includes: cost of the containerization engine and professional services required for installation and configuration, if any',
    ('containerization_engine', 'operating_cost'): 'Determining the annual operating cost of the containerization engine (where applicable)',
    ('license', 'type'): 'Specifying the license type (e.g.: permanent license, annual subscription, monthly subscription, etc.)',
    ('license', 'date_of_obtaining'): 'Determining the date on which the entity obtained the license',
    ('infrastructure_service', 'version'): 'Determining the release version of the infrastructure service according to the provider or manufacturer’s list',
    ('infrastructure_service', 'function'): 'Function performed by the infrastructure service, such as: DNS, DHCP, NTP, directory service, email service, communication service, collaboration service, backup and restore service',
    ('infrastructure_service', 'support_end_date'): 'Support end date for the infrastructure service as per the manufacturer',
    ('infrastructure_service', 'support_contract_status'): 'Determining the status of the support contract for the infrastructure service (active, expired)',
    ('infrastructure_service', 'capital_cost'): 'Determining the capital cost of the infrastructure service upon installation, which includes: cost of the technical service and professional services required for installation and configuration, if any',
    ('infrastructure_service', 'operating_cost'): 'Determining the annual operating cost of the infrastructure service (where applicable)',
    ('peripheral_device', 'location'): 'Name of the location that hosts this peripheral device, which may be the entity’s headquarters or one of its branches',
    ('peripheral_device', 'function'): 'Specifies the function of this accessory device or peripheral device (e.g.: laptop, desktop, printer, sensor, scanner)',
    ('peripheral_device', 'operating_system_or_firmware'): 'Identifies the operating system or firmware used for this peripheral device and its version',
}
for (bc, key), text in DESC.items():
    a = next(x for x in blocks[bc]['attributes'] if x['key'] == key)
    a['description_en'] = text

# Connection fixes (checked against both editions of the guide)
rels = seed['relations']
def find(s, v, t): return next((r for r in rels if r['source'] == s and r['verb'].lower() == v.lower() and r['target'] == t), None)
def add(s, v, t, ar_, desc):
    if not find(s, v, t): rels.append({'source': s, 'verb': v, 'target': t, 'description_en': desc, 'name_ar': ar_})
wrong = find('beneficiary', 'Owns', 'beneficiary_journey')
if wrong: rels.remove(wrong)
add('beneficiary', 'Represents', 'persona', 'يمثل', 'Identifying the persona that represents the type and specifications of a group of beneficiaries')
add('beneficiary_journey', 'Belongs To', 'persona', 'تنتمي إلى', 'The beneficiary journey manages the interactions with the persona')
add('persona', 'Owns', 'beneficiary_journey', 'تمتلك', 'The persona owns the journey of one or more beneficiaries')
add('service', 'Automated', 'application', 'مؤتمتة', 'Defining the service that is automated using a defined application')
add('security_hardware', 'Hosted In', 'data_center', 'مستضاف في', 'Determining the location of the security hardware in a data center')

# Every domain and block is active by default (entities can still switch off what they do not use).
for d in seed['domains']: d['active'] = True
for b in seed['blocks']: b['active'] = True
seed['version'] = 'dga-ea-cmm-1.0+r2'
seed['notes'] = ('Built from the DGA EA Content Meta Model guide v1.0 (Dec 2024): 7 domains, 45 building blocks, 375 attributes, '
                 f'{len(rels)} connections. Predefined lists carry the guide’s example values as open suggestions in Arabic and English.')
json.dump(seed, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('lists', filled, 'relations', len(rels))
