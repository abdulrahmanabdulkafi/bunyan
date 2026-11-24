"""Parse NCA control tables (Arabic, RTL) from cidpage output.
Columns (right to left): subdomain code | control code | [subcontrol code] text."""
import json, re, sys, unicodedata
from lines import line_text

AD = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
CODE = re.compile(r'^[0-9٠-٩]+(?:-[0-9٠-٩]+)+$')

def norm(s):
    s = unicodedata.normalize('NFKC', s)
    s = re.sub(r'[‎‏‪-‮ـ]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    # A quoted acronym at the end of a Latin run loses its closing quote to the run boundary: (”Sender Policy Framework “SPF) → (Sender Policy Framework “SPF”)
    s = re.sub(r'\(”([^()”“]+?) “([^()”“]+?)\)', r'(\1 “\2”)', s)
    return s

def group_lines(chars, tol=3.0):
    """Cluster chars into visual lines by vertical centre."""
    cs = sorted(chars, key=lambda c: (c[3] + c[4]) / 2)
    lines = []
    for c in cs:
        yc = (c[3] + c[4]) / 2
        if lines and abs(lines[-1]['yc'] - yc) <= tol:
            lines[-1]['chars'].append(c)
            n = len(lines[-1]['chars']); lines[-1]['yc'] += (yc - lines[-1]['yc']) / n
        else:
            lines.append({'yc': yc, 'chars': [c]})
    return lines

def tokens(line):
    """Split a visual line into tokens separated by large gaps (left to right)."""
    cs = sorted(line['chars'], key=lambda c: c[1])
    toks, cur = [], [cs[0]]
    for c in cs[1:]:
        if c[1] - cur[-1][2] > 6:
            toks.append(cur); cur = [c]
        else:
            cur.append(c)
    toks.append(cur)
    return toks

def code_of(tok):
    """Visual digits+hyphens, left to right; Arabic documents print codes reversed, so reverse the parts."""
    s = ''.join(c[0] for c in sorted(tok, key=lambda c: c[1])).replace(' ', '')
    if not CODE.match(s): return None
    parts = s.translate(AD).split('-')
    return '-'.join(reversed(parts))

def parse(pages, first_page=0, last_page=None, header_px=60, footer_px=60):
    """Return list of (code, text) for controls and subcontrols in reading order."""
    items, cur_ctrl, cur_sub, ctrl_col = [], None, None, None
    for pi, pg in enumerate(pages[first_page:last_page], start=first_page):
        H = pg['h']
        chars = [c for c in pg['chars'] if header_px < c[3] < H - footer_px and c[0].strip()]
        if not chars: continue
        lines = group_lines(chars)
        # find code tokens and their columns
        codes = []
        for ln in lines:
            for tk in tokens(ln):
                cd = code_of(tk)
                if cd: codes.append({'code': cd, 'x0': min(c[1] for c in tk), 'x1': max(c[2] for c in tk), 'yc': ln['yc'], 'chars': tk})
        known = {c['code'] for c in codes if c['code'].count('-') == 2}
        for c in codes:
            parts = c['code'].split('-')
            if len(parts) == 4 and '-'.join(parts[:3]) not in known:
                import itertools
                for perm in itertools.permutations(parts[:3]):
                    if '-'.join(perm) in known:
                        c['code'] = '-'.join(list(perm) + parts[3:]); break
        yield_page = {'pi': pi, 'lines': lines, 'codes': codes, 'hl': pg['hl']}
        items.append(yield_page)
    return items

def extract_controls(pages, start=0, end=None, colx=None, header_px=60, footer_px=60, min_parts=3, mirror=True):
    """Returns ordered dict code -> {'text': str, 'kind': 'subdomain'|'control'|'subcontrol'}."""
    from collections import OrderedDict
    out = OrderedDict()
    last_ctrl, last_target = None, None
    for p in parse(pages, start, end, header_px, footer_px):
        codes = p['codes']
        ctrl = [c for c in codes if c['code'].count('-') == min_parts - 1]
        if ctrl:
            colx = (min(c['x0'] for c in ctrl), max(c['x1'] for c in ctrl))
        if colx is None: continue
        cx0, cx1 = colx
        mid = (cx0 + cx1) / 2
        rules = sorted({round(h[2]) for h in p['hl'] if h[0] <= cx0 - 3 and h[1] >= cx1 + 3})
        merged = []
        for y in rules:
            if not merged or y - merged[-1] > 2: merged.append(y)
        code_char_ids = {id(ch) for c in codes for ch in c['chars']}
        text_lines = []
        for ln in p['lines']:
            cs = [c for c in ln['chars'] if id(c) not in code_char_ids and c[2] < cx0 - 1]
            if cs: text_lines.append({'yc': ln['yc'], 'chars': cs})
        bounds = [-1e9] + merged + [1e9]
        for a, b in zip(bounds, bounds[1:]):
            bc = [c for c in codes if a < c['yc'] < b]
            bl = [l for l in text_lines if a < l['yc'] < b]
            if not bc and not bl: continue
            sub_dom = [c for c in bc if c['code'].count('-') == min_parts - 2]
            ctrls = [c for c in bc if c['code'].count('-') == min_parts - 1]
            subs = sorted([c for c in bc if c['code'].count('-') == min_parts], key=lambda c: c['yc'])
            if sub_dom and not ctrls:
                out[sub_dom[0]['code']] = {'kind': 'subdomain', 'text': ' '.join(line_text(l['chars'], mirror=mirror) for l in sorted(bl, key=lambda l: l['yc']))}
                last_ctrl = last_target = None
                continue
            if ctrls:
                last_ctrl = ctrls[0]['code']
                out.setdefault(last_ctrl, {'kind': 'control', 'text': ''})
                last_target = last_ctrl
            elif not subs and last_target and a == bounds[0]:
                pass  # page-top continuation of the previous control or subcontrol
            elif not subs:
                last_ctrl = last_target = None  # objective / headings
                continue
            if not last_ctrl:
                # subcontrols whose control cell starts lower in the band: the parent comes from the code itself
                last_ctrl = '-'.join(subs[0]['code'].split('-')[:-1])
                out.setdefault(last_ctrl, {'kind': 'control', 'text': ''})
                last_target = last_ctrl
            bl = sorted(bl, key=lambda l: l['yc'])
            si = 0
            for l in bl:
                while si < len(subs) and subs[si]['yc'] <= l['yc'] + 4:
                    last_target = subs[si]['code']
                    out.setdefault(last_target, {'kind': 'subcontrol', 'text': ''})
                    si += 1
                t = line_text(l['chars'], mirror=mirror)
                m = re.match(r'^[”“"\s]*([0-9٠-٩]+(?:-[0-9٠-٩]+){%d})\s*(.*)$' % (min_parts), t)
                if m:
                    parts = m.group(1).translate(AD).split('-')
                    for cand in ('-'.join(reversed(parts)), '-'.join(parts)):
                        if cand.startswith(last_ctrl + '-'):
                            last_target = cand
                            out.setdefault(cand, {'kind': 'subcontrol', 'text': ''})
                            t = m.group(2); break
                out[last_target]['text'] = (out[last_target]['text'] + ' ' + t).strip()
            while si < len(subs):
                last_target = subs[si]['code']; out.setdefault(last_target, {'kind': 'subcontrol', 'text': ''}); si += 1
    for v in out.values(): v['text'] = norm(v['text'])
    return out
