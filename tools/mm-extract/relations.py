"""Extract the connection tables of the DGA "EA Content Meta Model" document (English) with word coordinates.
Usage: python3 relations.py <meta-model.pdf> <seed.json>  → prints rows and the differences with the seed."""
import sys, re, json
import pymupdf

pdf, seedf = sys.argv[1], sys.argv[2]
doc = pymupdf.open(pdf)
seed = json.load(open(seedf))
name2code = {}
for b in seed['blocks']:
    name2code[re.sub(r'[^a-z]', '', b['name_en'].lower())] = b['code']
name2code.update({'modeltemplate': 'model_template', 'kpi': 'key_performance_indicator', 'performanceindicator': 'key_performance_indicator'})

name2code.update({'applicationmodule': 'application_modules', 'licenses': 'license', 'dataattribute': 'data_attributes'})
DESC = {'Identifying', 'Determining', 'Specifying', 'Defining', 'Measuring', 'Explaining', 'The', 'Describing', 'Linking', 'Indicating', 'Setting', 'Clarifying'}
SMALL = {'to', 'by', 'in', 'with', 'through', 'from', 'of', 'into', 'under', '/', 'for', 'on'}

def code_of(txt):
    toks = [t for t in re.findall(r"[A-Za-z/]+", txt or '') if t[0].isupper() or t == '/']
    best = None
    for i in range(len(toks)):
        for j in range(len(toks), i, -1):
            k = re.sub(r'[^a-z]', '', ''.join(toks[i:j]).lower())
            if k in name2code and (best is None or j - i > best[0]): best = (j - i, name2code[k])
    return best[1] if best else None

def clean_verb(ws):
    out = []
    for w in ws:
        t = w[4]
        if t in DESC: continue
        if t[0].isupper() or t.lower() in SMALL: out.append(t)
    return ' '.join(out)

starts = [i for i, p in enumerate(doc) if 'Description of the' in p.get_text() and 'Connection' in p.get_text()]
rows_all = []
for si, sp in enumerate(starts):
    end = starts[si + 1] if si + 1 < len(starts) else len(doc)
    # the table ends at the next "Artifacts of the" heading
    pages = []
    for pn in range(sp, end):
        t = doc[pn].get_text()
        pages.append(pn)
        if pn > sp and re.search(r'5\.3\.\d\s+Artifacts of the', t): break
    hdr = doc[sp].get_text('words')
    # column x boundaries from the header
    xs = {}
    hw = [w for w in hdr if w[4] in ('#', 'Domain', 'Connection', 'Building', 'Description')]
    hy = min(w[1] for w in hw if w[4] == 'Description')
    hw = [w for w in hw if abs(w[1] - hy) < 25]
    doms = sorted(w[0] for w in hw if w[4] == 'Domain')
    builds = sorted(w[0] for w in hw if w[4] == 'Building')
    conn = [w[0] for w in hw if w[4] == 'Connection'][0]
    desc = [w[0] for w in hw if w[4] == 'Description'][0]
    hdr_bottom = max(w[3] for w in hw) + 8
    # column order in the English doc: # | Domain | Building Block | Connection | Description | Building Block | Domain
    cut = [doms[0] - 5, builds[0] - 8, conn - 12, desc - 10, builds[-1] - 25, doms[-1] - 15]
    def col(x):
        c = 0
        for i, v in enumerate(cut):
            if x >= v: c = i + 1
        return c  # 0 num,1 sdom,2 sblock,3 conn,4 desc,5 target,6 tdom
    prev_label = None
    for pn in pages:
        words = [w for w in doc[pn].get_text('words') if w[1] > (hdr_bottom if pn == sp else 60) and w[1] < 740]
        # stop at the next section heading
        stop = [w[1] for w in words if re.match(r'5\.3\.\d', w[4]) and w[0] < 120]
        if stop: words = [w for w in words if w[1] < min(stop) - 2]
        nums = sorted([(w[1] + w[3]) / 2 for w in words if col(w[0]) == 0 and re.fullmatch(r'\d{1,3}', w[4])])
        numv = {round((w[1] + w[3]) / 2): int(w[4]) for w in words if col(w[0]) == 0 and re.fullmatch(r'\d{1,3}', w[4])}
        if not nums: continue
        def nearest(y): return min(range(len(nums)), key=lambda i: abs(nums[i] - y))
        cells = [{'n': numv[round(y)], 'y': y, 'conn': [], 'tgt': []} for y in nums]
        lab_lines = {}
        for w in words:
            c = col(w[0]); y = (w[1] + w[3]) / 2
            if c == 3: cells[nearest(y)]['conn'].append(w)
            elif c == 5: cells[nearest(y)]['tgt'].append(w)
            elif c == 2: lab_lines.setdefault(round(y), []).append(w)
        # group source label lines into labels (lines closer than 16pt)
        labels = []
        for y in sorted(lab_lines):
            ws = sorted(lab_lines[y], key=lambda w: w[0])
            txt = ' '.join(w[4] for w in ws)
            if labels and y - labels[-1]['y1'] < 24: labels[-1]['t'] += ' ' + txt; labels[-1]['y1'] = y
            else: labels.append({'t': txt, 'y0': y, 'y1': y})
        for l in labels: l['y'] = (l['y0'] + l['y1']) / 2
        # DP: split the ordered rows into contiguous groups, one per label (plus an optional group continuing the previous page's label)
        L = ([{'t': prev_label, 'y': -1e9}] if prev_label else []) + labels
        n, k = len(cells), len(L)
        INF = float('inf')
        best = [[INF] * (k + 1) for _ in range(n + 1)]; back = [[None] * (k + 1) for _ in range(n + 1)]
        best[0][0] = 0
        for j in range(1, k + 1):
            for i in range(0, n + 1):
                for s in range(0, i + 1):
                    if best[s][j - 1] == INF: continue
                    if s == i: cost = 0 if (j == 1 and prev_label) else 200  # a label without rows is unlikely
                    elif L[j - 1]['y'] < -1e8: cost = sum(max(0, cells[r]['y'] - (labels[0]['y'] if labels else 1e9)) for r in range(s, i)) * 0.5
                    else: cost = abs((cells[s]['y'] + cells[i - 1]['y']) / 2 - L[j - 1]['y'])
                    if best[s][j - 1] + cost < best[i][j]: best[i][j] = best[s][j - 1] + cost; back[i][j] = s
        i, j = n, k
        assign = [None] * n
        while j > 0:
            s = back[i][j]
            for r in range(s, i): assign[r] = L[j - 1]['t']
            i, j = s, j - 1
        for c, src in zip(cells, assign):
            verb = clean_verb(sorted(c['conn'], key=lambda w: (round(w[1] / 4), w[0])))
            tgt = ' '.join(w[4] for w in sorted(c['tgt'], key=lambda w: (round(w[1] / 4), w[0])))
            rows_all.append({'sec': si, 'n': c['n'], 'page': pn + 1, 'src': src, 'verb': verb, 'tgt': tgt,
                             's': code_of(src or ''), 't': code_of(tgt)})
        if labels: prev_label = labels[-1]['t']

json.dump(rows_all, open('/tmp/mm_rel_rows.json', 'w'), ensure_ascii=False, indent=0)
norm = lambda v: re.sub(r'\s+', ' ', v.strip().lower())
doc_set = {(r['s'], norm(r['verb']), r['t']) for r in rows_all}
seed_set = {(r['source'], norm(r['verb']), r['target']) for r in seed['relations']}
print('doc rows', len(rows_all), 'unique', len(doc_set), 'seed', len(seed_set))
bad = [r for r in rows_all if not r['s'] or not r['t']]
print('unresolved', len(bad))
for r in bad: print('  ?', r)
print('IN DOC NOT SEED'); [print('  ', x) for x in sorted(doc_set - seed_set, key=str)]
print('IN SEED NOT DOC'); [print('  ', x) for x in sorted(seed_set - doc_set, key=str)]
