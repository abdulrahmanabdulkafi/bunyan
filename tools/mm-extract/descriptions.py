"""Re-read attribute descriptions from the English meta-model guide (pdftotext -layout output) and repair the
seed's empty or run-together ones. Each description line belongs to the nearest numbered row (cells are centred).
Usage: pdftotext -layout guide.pdf mm.txt; python3 descriptions.py mm.txt seed.json [--show] [--write]"""
import sys, re, json
txt, seedf = sys.argv[1], sys.argv[2]
t = open(txt, encoding='utf-8').read().split('\n')
seed = json.load(open(seedf, encoding='utf-8'))
byname = {re.sub(r'[^a-z]', '', b['name_en'].lower()): b for b in seed['blocks']}
heads = [(i, re.search(r'“([^”“]+)', l).group(1)) for i, l in enumerate(t) if re.search(r'Building [Bb]lock\s*-\s*“', l)]
found = {}
for k, (i, name) in enumerate(heads):
    b = byname.get(re.sub(r'[^a-z]', '', name.lower()))
    j = heads[k + 1][0] if k + 1 < len(heads) else i + 200
    seg = []
    for l in t[i + 1:j]:
        if 'The following figure' in l or re.match(r'\s+5\.3\.\d\.\d\s', l): break
        if not l.strip() or 'Meta Model” Document' in l or re.match(r'\s*Public -', l): continue
        seg.append(l)
    if not b or not seg: continue
    hdr = next(l for l in seg if 'Attribute Description' in l)
    dpos, tpos = hdr.index('Attribute Description'), hdr.index('Attribute Type')
    apos = hdr.index('Attribute')
    rows, lines = [], []
    for l in seg:
        if l is hdr: continue
        chunks = [(m.start(), m.group()) for m in re.finditer(r'\S+(?: \S+)*', l)]
        num = re.match(r'\s*(\d{1,2})\s{2,}', l)
        desc = []
        for pos, c in chunks:
            if num and pos == num.start(1): continue
            centre = pos + len(c) / 2
            # nearest of the three text columns by distance to the column's span
            spans = {'a': (apos - 6, dpos - 4), 'd': (dpos - 4, tpos - 6), 't': (tpos - 6, 999)}
            col = min(spans, key=lambda s: 0 if spans[s][0] <= centre <= spans[s][1] else min(abs(centre - spans[s][0]), abs(centre - spans[s][1])))
            if col == 'd': desc.append(c)
        lines.append((len(lines), int(num.group(1)) if num else None, ' '.join(desc)))
    numbered = [(ix, n) for ix, n, _ in lines if n]
    if not numbered: continue
    out = {n: [] for _, n in numbered}
    for ix, _, d in lines:
        if not d: continue
        best = min(numbered, key=lambda x: (abs(x[0] - ix), x[0] < ix))  # ties go to the row below
        out[best[1]].append(d)
    for n, ds in out.items():
        found[(b['code'], n)] = re.sub(r'\s+', ' ', ' '.join(ds)).strip()
bad = lambda s: not s or s[:1].islower() or s.endswith((' the', ' of', ' and', ' a', ' to', ' or', ',', ' an', ' with'))
fixed = 0
for b in seed['blocks']:
    broken = any(bad(a.get('description_en') or '') for a in b['attributes'])
    if not broken: continue
    for a in b['attributes']:
        d = found.get((b['code'], a['order']))
        if d and d != a.get('description_en'):
            if '--show' in sys.argv: print(f"{b['code']}.{a['key']}\n  old: {a.get('description_en')}\n  new: {d}")
            a['description_en'] = d; fixed += 1
print('parsed', len(found), 'repaired', fixed, 'still odd', [(b['code'], a['key']) for b in seed['blocks'] for a in b['attributes'] if bad(a.get('description_en') or '')])
if '--write' in sys.argv: json.dump(seed, open(seedf, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
