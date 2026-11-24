import openpyxl, re, unicodedata, json, sys
AD = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
def n(s):
    s = unicodedata.normalize('NFKC', str(s or ''))
    return re.sub(r'\s+', ' ', s).strip()
def split_bi(s):
    """'الاسم (English)' -> (ar, en)"""
    m = re.match(r'^(.*?)\s*\(([A-Za-z][^()]*(?:\([^()]*\)[^()]*)*)\)\s*$', s)
    return (m.group(1).strip(), m.group(2).strip()) if m else (s, None)
def parse(path, sheet):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = [w for w in wb.worksheets if w.title.strip() == sheet.strip()][0]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    head = None
    for i, r in enumerate(rows):
        if any(c and 'رقم الضابط' in str(c) for c in r): head = i; break
    H = [n(c) for c in rows[head]]
    def col(word): return next(i for i, h in enumerate(H) if word in h)
    cD, cS, cT, cR, cX = col('المكون الأساسي'), col('المكون الفرعي'), col('نوع الضابط'), col('رقم الضابط'), col('نص الضابط')
    items, dom, sub = {}, None, None
    for r in rows[head + 1:]:
        r = r + [None] * (len(H) - len(r))
        d = n(r[cD]); s_ = n(r[cS]); ref = n(r[cR]).translate(AD)
        raw = str(r[cX] or '')
        # Cells hold the Arabic text, a blank line, then the official English text.
        parts = [p for p in re.split(r'\n\s*\n', raw) if p.strip()]
        ar_parts = [p for p in parts if re.search(r'[\u0600-\u06FF]', p)]
        en_parts = [p for p in parts if not re.search(r'[\u0600-\u06FF]', p)]
        txt = n(' '.join(ar_parts)); txt_en = n(' '.join(en_parts)) or None
        if d:
            m = re.match(r'^([0-9٠-٩]+)\s*[-–]\s*(.*)$', d)
            if m:
                dom = m.group(1).translate(AD); ar, en = split_bi(m.group(2))
                items.setdefault(dom, {'level': 'domain', 'title_ar': ar, 'title_en': en})
        if s_:
            if re.match(r'^[0-9٠-٩]+-[0-9٠-٩]+$', s_):
                sub = s_.translate(AD)
            else:
                ar, en = split_bi(s_)
                if sub: items.setdefault(sub, {'level': 'subdomain', 'title_ar': ar, 'title_en': en, 'parent': dom})
        # sub code and name may sit in adjacent columns: scan the row for an "N-N" cell followed by a name
        for i, c in enumerate(r):
            cs = n(c).translate(AD)
            if re.match(r'^\d+-\d+$', cs) and i + 1 < len(r) and n(r[i + 1]) and not re.match(r'^[0-9-]+$', n(r[i + 1]).translate(AD)) and i < cT:
                sub = cs
                ar, en = split_bi(n(r[i + 1]))
                items.setdefault(sub, {'level': 'subdomain', 'title_ar': ar, 'title_en': en, 'parent': sub.split('-')[0]})
        if ref and re.match(r'^\d+(-\d+)+$', ref) and not ref.startswith((sub or '') + '-'):
            rv = '-'.join(reversed(ref.split('-')))
            if sub and rv.startswith(sub + '-'): ref = rv  # some cells store the code right-to-left
        if ref and re.match(r'^\d+(-\d+)+$', ref) and txt:
            lvl = 'control' if ref.count('-') == 2 else 'subcontrol'
            items[ref] = {'level': lvl, 'title_ar': txt, 'title_en': txt_en, 'parent': '-'.join(ref.split('-')[:-1])}
    # Domain numbers come from the subdomains under them (one sheet labels the third domain "4").
    doms = [k for k, v in items.items() if v['level'] == 'domain']
    order = []
    for k, v in items.items():
        if v['level'] == 'subdomain':
            d = k.split('-')[0]
            if d not in order: order.append(d)
    fixed = {}
    for old, new in zip(doms, order):
        fixed[new] = items[old]
    out = dict(fixed)
    for k, v in items.items():
        if v['level'] != 'domain':
            if v['level'] == 'subdomain': v['parent'] = k.split('-')[0]
            out[k] = v
    return out
if __name__ == '__main__':
    it = parse(sys.argv[1], sys.argv[2])
    import collections
    print(collections.Counter(v['level'] for v in it.values()))
    json.dump(it, open(sys.argv[3], 'w'), ensure_ascii=False, indent=1)
