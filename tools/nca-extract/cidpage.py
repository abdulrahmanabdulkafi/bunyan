"""Per-page chars (with dropped-ligature CIDs decoded) and horizontal rules, top-origin coordinates."""
import sys, json
from pdfminer.pdfinterp import PDFResourceManager, PDFPageInterpreter
from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LAParams, LTChar, LTLine, LTRect, LTCurve
from pdfminer.pdfpage import PDFPage

class Agg(PDFPageAggregator):
    def render_char(self, matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate):
        adv = super().render_char(matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate)
        self.cur_item._objs[-1].cid = cid
        return adv

def extract(path, cidmap):
    rm = PDFResourceManager()
    dev = Agg(rm, laparams=None)
    it = PDFPageInterpreter(rm, dev)
    pages, unknown = [], {}
    with open(path, 'rb') as f:
        for pg in PDFPage.get_pages(f):
            it.process_page(pg)
            L = dev.get_result()
            H = L.height
            chars, hl = [], []
            def walk(o):
                if isinstance(o, LTChar):
                    t = o.get_text()
                    if t == '\x00':
                        key = str(o.cid)
                        t = cidmap.get(key)
                        if t is None:
                            unknown[key] = unknown.get(key, 0) + 1
                            t = f'⟦{key}⟧'
                    chars.append([t, round(o.x0, 1), round(o.x1, 1), round(H - o.y1, 1), round(H - o.y0, 1), round(o.size, 1)])
                elif isinstance(o, (LTLine, LTRect, LTCurve)):
                    if o.height < 2.5 and o.width > 8:
                        hl.append([round(o.x0, 1), round(o.x1, 1), round(H - (o.y0 + o.y1) / 2, 1)])
                    elif isinstance(o, LTRect) and o.height >= 2.5:
                        # rect borders also act as row rules
                        hl.append([round(o.x0, 1), round(o.x1, 1), round(H - o.y1, 1)])
                        hl.append([round(o.x0, 1), round(o.x1, 1), round(H - o.y0, 1)])
                elif hasattr(o, '__iter__'):
                    for x in o: walk(x)
            walk(L)
            pages.append({'w': L.width, 'h': H, 'chars': chars, 'hl': hl})
    return pages, unknown

if __name__ == '__main__':
    cidmap = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
    pages, unknown = extract(sys.argv[1], cidmap)
    json.dump(pages, open(sys.argv[2], 'w'), ensure_ascii=False)
    print('pages', len(pages), 'unknown cids', unknown)
