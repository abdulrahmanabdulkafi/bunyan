import json, re
OUT = '/home/claude/bunyan/packages/seed/'
DOM = {
  'std': [('1', 'حوكمة الأمن السيبراني', 'Cybersecurity Governance'), ('2', 'تعزيز الأمن السيبراني', 'Cybersecurity Defense'),
          ('3', 'صمود الأمن السيبراني', 'Cybersecurity Resilience'), ('4', 'الأمن السيبراني المتعلق بالأطراف الخارجية والحوسبة السحابية', 'Third-Party and Cloud Computing Cybersecurity')],
}
ECC_EN = {x['code']: x['title_en'] for x in json.load(open(OUT + 'nca-ecc-2-2024.json'))['items']}

def split_title(s):
    s = s.strip()
    m = re.match(r'^(.*?)\s*\((.*[A-Za-z].*)\)\s*$', s)
    if m and re.search(r'[؀-ۿ]', m.group(1)): return m.group(1).strip(), m.group(2).strip().strip('“”"')
    if not re.search(r'[؀-ۿ]', s): return '', s.strip('() ')
    return s, None

def short(t, n=140):
    if len(t) <= n: return t
    cut = t[:n]
    sp = cut.rfind(' ')
    return (cut[:sp] if sp > 60 else cut) + '…'

def key(c): return [int(x) for x in c.split('-')]

def from_pdf(src, domains, fixes={}, en_override={}):
    it = json.load(open(src))
    items = []
    doms = set(c.split('-')[0] for c in it)
    for i, (c, ar, en) in enumerate(d for d in domains if d[0] in doms):
        items.append({'code': c, 'level': 'domain', 'parent': None, 'title_ar': ar, 'title_en': en})
    for c, v in sorted(it.items(), key=lambda kv: key(kv[0])):
        p = '-'.join(c.split('-')[:-1])
        if v['kind'] == 'subdomain':
            ar, en = split_title(fixes.get(c, v['text']))
            items.append({'code': c, 'level': 'subdomain', 'parent': p, 'title_ar': ar, 'title_en': en_override.get(c, en)})
        else:
            t = v['text']
            items.append({'code': c, 'level': v['kind'], 'parent': p, 'title_ar': short(t) or c, 'title_en': None, 'text_ar': t or None})
    return items

def from_xlsx(src, domains_en):
    it = json.load(open(src))
    items = []
    for c, v in sorted(it.items(), key=lambda kv: key(kv[0])):
        lvl = v['level']
        if lvl == 'domain':
            items.append({'code': c, 'level': 'domain', 'parent': None, 'title_ar': v['title_ar'], 'title_en': v.get('title_en') or domains_en.get(c)})
        elif lvl == 'subdomain':
            items.append({'code': c, 'level': 'subdomain', 'parent': c.split('-')[0], 'title_ar': v['title_ar'], 'title_en': v.get('title_en')})
        else:
            items.append({'code': c, 'level': lvl, 'parent': v['parent'], 'title_ar': short(v['title_ar']), 'title_en': short(v['title_en']) if v.get('title_en') else None,
                          'text_ar': v['title_ar'], 'text_en': v.get('title_en')})
    return items

def save(name, meta, items, note):
    for i, x in enumerate(items): x['sort'] = i
    counts = {l: sum(1 for x in items if x['level'] == l) for l in ('domain', 'subdomain', 'control', 'subcontrol')}
    json.dump({**meta, 'issuer_ar': 'الهيئة الوطنية للأمن السيبراني', 'issuer_en': 'National Cybersecurity Authority',
               'counts': counts, 'note': note, 'items': items}, open(OUT + name, 'w'), ensure_ascii=False, indent=1)
    print(name, counts)

std = DOM['std']
save('nca-ecc-2-2024.json', {'code': 'ECC', 'version': '2:2024', 'name_ar': 'الضوابط الأساسية للأمن السيبراني', 'name_en': 'Essential Cybersecurity Controls'},
     from_pdf('cid/ecc.items.json', std, en_override={k: v for k, v in ECC_EN.items() if k.count('-') == 1}),
     'Extracted from the official Arabic ECC-2:2024 document; matches its stated totals (4 domains, 28 subdomains, 108 controls, 92 subcontrols).')
save('nca-cscc-2-2026.json', {'code': 'CSCC', 'version': '2:2026', 'name_ar': 'ضوابط الأمن السيبراني للأنظمة الحساسة', 'name_en': 'Critical Systems Cybersecurity Controls'},
     from_pdf('cid/cscc.items.json', std, fixes={'3-1': 'جوانب صمود الأمن السيبراني في إدارة استمرارية الأعمال (Cybersecurity Resilience aspects of Business Continuity Management “BCM”)'}),
     'Extracted from the official Arabic CSCC-2:2026 document. The document states 32 main controls; its tables number 33 (subdomain 2-3 has controls 2-3-1 and 2-3-4). Codes are kept exactly as printed.')
otcc_dom = std[:3] + [('4', 'الأمن السيبراني المتعلق بالأطراف الخارجية', 'Third-Party Cybersecurity')]
save('nca-otcc-1-2022.json', {'code': 'OTCC', 'version': '1:2022', 'name_ar': 'ضوابط الأمن السيبراني للأنظمة التشغيلية', 'name_en': 'Operational Technology Cybersecurity Controls'},
     from_pdf('cid/otcc.items.json', otcc_dom, fixes={'3-1': 'جوانب صمود الأمن السيبراني في إدارة استمرارية الأعمال (Cybersecurity Resilience Aspects of Business Continuity Management (BCM))'}),
     'Extracted from the official Arabic OTCC-1:2022 document; matches its stated totals (23 subdomains, 47 controls, 122 subcontrols). Control applicability levels (L1–L3) are not loaded yet.')
dom_en = {d[0]: d[2] for d in std}
save('nca-dcc-1-2022.json', {'code': 'DCC', 'version': '1:2022', 'name_ar': 'ضوابط الأمن السيبراني للبيانات', 'name_en': 'Data Cybersecurity Controls'},
     from_xlsx('cid/dcc.items.json', dom_en), 'From the official NCA DCC assessment and compliance tool V1.0 (Arabic and English texts); matches the document totals (11 subdomains, 19 controls, 47 subcontrols).')
save('nca-tcc-1-2021.json', {'code': 'TCC', 'version': '1:2021', 'name_ar': 'ضوابط الأمن السيبراني للعمل عن بعد', 'name_en': 'Telework Cybersecurity Controls'},
     from_xlsx('cid/tcc.items.json', dom_en), 'From the official NCA TCC assessment and compliance tool v2.0 (Arabic texts); matches the document totals (16 subdomains, 21 controls, 42 subcontrols).')
ccc_sub = [('1-1','أدوار ومسؤوليات الأمن السيبراني','Cybersecurity Roles and Responsibilities'),('1-2','إدارة مخاطر الأمن السيبراني','Cybersecurity Risk Management'),
 ('1-3','الالتزام بتشريعات وتنظيمات ومعايير الأمن السيبراني','Compliance with Cybersecurity Standards, Laws and Regulations'),('1-4','الأمن السيبراني المتعلق بالموارد البشرية','Cybersecurity in Human Resources'),
 ('1-5','الأمن السيبراني ضمن إدارة التغيير','Cybersecurity in Change Management'),('2-1','إدارة الأصول','Asset Management'),('2-2','إدارة هويات الدخول والصلاحيات','Identity and Access Management'),
 ('2-3','حماية الأنظمة وأجهزة معالجة المعلومات','Information System and Information Processing Facilities Protection'),('2-4','إدارة أمن الشبكات','Networks Security Management'),
 ('2-5','أمن الأجهزة المحمولة','Mobile Devices Security'),('2-6','حماية البيانات والمعلومات','Data and Information Protection'),('2-7','التشفير','Cryptography'),
 ('2-8','إدارة النسخ الاحتياطية','Backup and Recovery Management'),('2-9','إدارة الثغرات','Vulnerabilities Management'),('2-10','اختبار الاختراق','Penetration Testing'),
 ('2-11','إدارة سجلات الأحداث ومراقبة الأمن السيبراني','Cybersecurity Event Logs and Monitoring Management'),('2-12','إدارة حوادث وتهديدات الأمن السيبراني','Cybersecurity Incident and Threat Management'),
 ('2-13','الأمن المادي','Physical Security'),('2-14','حماية تطبيقات الويب','Web Application Security'),('2-15','إدارة المفاتيح','Key Management'),('2-16','أمن تطوير الأنظمة','System Development Security'),
 ('2-17','أمن وسائط التخزين','Storage Media Security'),('3-1','جوانب صمود الأمن السيبراني في إدارة استمرارية الأعمال','Cybersecurity Resilience aspects of Business Continuity Management (BCM)'),
 ('4-1','الأمن السيبراني المتعلق بسلسلة الإمداد والأطراف الخارجية','Supply Chain and Third-Party Cybersecurity')]
ccc_items = [{'code': d[0], 'level': 'domain', 'parent': None, 'title_ar': d[1], 'title_en': d[2]} for d in std[:3] + [('4', 'الأمن السيبراني المتعلق بالأطراف الخارجية', 'Third-Party Cybersecurity')]]
ccc_items += [{'code': c, 'level': 'subdomain', 'parent': c.split('-')[0], 'title_ar': a, 'title_en': e} for c, a, e in ccc_sub]
save('nca-ccc-2-2024.json', {'code': 'CCC', 'version': '2:2024', 'name_ar': 'ضوابط الأمن السيبراني للحوسبة السحابية', 'name_en': 'Cloud Cybersecurity Controls'},
     ccc_items, 'Structure only (4 domains, 24 subdomains) from figure 2 of the official CCC-2:2024 document. Its control tables are images, so control texts are loaded later from a text source (e.g. the NCA CCC assessment tool).')

# Fill missing English subdomain names from the same Arabic name in the other frameworks, and tidy quotes.
import glob
files = sorted(glob.glob(OUT + 'nca-*.json'))
ar2en = {}
for f in files:
    for x in json.load(open(f))['items']:
        if x['level'] in ('subdomain', 'domain') and x.get('title_en'): ar2en.setdefault(x['title_ar'], x['title_en'])
for f in files:
    d = json.load(open(f))
    for x in d['items']:
        if x['level'] in ('subdomain', 'domain'):
            if not x.get('title_en'): x['title_en'] = ar2en.get(x['title_ar'])
            if x.get('title_en'): x['title_en'] = re.sub(r'\s*[“”"]\s*BCM[“”"]?', ' (BCM)', x['title_en']).strip()
    missing = [x['code'] for x in d['items'] if x['level'] in ('domain', 'subdomain') and not x.get('title_en')]
    if missing: print(f, 'still missing EN', missing)
    json.dump(d, open(f, 'w'), ensure_ascii=False, indent=1)
