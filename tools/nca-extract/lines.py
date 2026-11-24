import json, re, unicodedata
LTR = re.compile(r'[A-Za-z0-9٠-٩\.\-/:,%&@\'"_+=]')
def line_text(chars, rtl=True, mirror=True):
    """Visual chars -> logical string. Chars are [text, x0, x1]."""
    cs = sorted(chars, key=lambda c: -(c[1] + c[2]) / 2) if rtl else sorted(chars, key=lambda c: c[1])
    # Insert spaces for gaps
    out = []
    prev = None
    for c in cs:
        if prev is not None:
            gap = (prev[1] - c[2]) if rtl else (c[1] - prev[2])
            if gap > 1.5 and c[0] != ' ' and (not out or out[-1][0] != ' '): out.append([' ', 0, 0])
        out.append(c); prev = c
    toks = [c[0] for c in out]
    # reverse maximal runs of LTR tokens (Latin letters, digits and joiners between them)
    res, i = [], 0
    def is_ltr(t): return bool(re.match(r'[A-Za-z0-9٠-٩]', t))
    while i < len(toks):
        if is_ltr(toks[i]):
            j = i
            while j < len(toks) and (is_ltr(toks[j]) or (toks[j] in ' .-/:,_&+"\'“”‘’' and j + 1 < len(toks) and any(is_ltr(x) for x in toks[j+1:j+4]))):
                j += 1
            run = toks[i:j]
            while run and not is_ltr(run[-1]): j -= 1; run = toks[i:j]
            res.extend(reversed(run)); i = j
        else:
            t = toks[i]
            res.append({'(': ')', ')': '(', '[': ']', ']': '['}.get(t, t) if mirror else t); i += 1
    s = ''.join(res)
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', s)).strip()
