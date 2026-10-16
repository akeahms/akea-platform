# Builds the Stone & Forest brand assets (SVG) from Cormorant Garamond Italic outlines.
# Values follow the kit (Kit06.dc.html): wordmark weight 300, letter-spacing -0.03em, bronze diamond.
import sys, os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

SRC = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)

FOREST, BRONZE, CREAM, GOLD = "#14241F", "#9C7A43", "#EDE6D8", "#C9A66B"
_cache = {}

def font(w):
    if w not in _cache:
        _cache[w] = instantiateVariableFont(TTFont(SRC), {"wght": w}, inplace=False)
    return _cache[w]

def kern_pairs(f):
    """Pair adjustments from GPOS 'kern' (formats 1 and 2)."""
    pairs = {}
    if "GPOS" not in f: return pairs
    g = f["GPOS"].table
    idx = set()
    for fr in g.FeatureList.FeatureRecord:
        if fr.FeatureTag == "kern": idx.update(fr.Feature.LookupListIndex)
    for i in idx:
        lk = g.LookupList.Lookup[i]
        for st in lk.SubTable:
            if lk.LookupType == 9: st = st.ExtSubTable
            if getattr(st, "LookupType", 2) != 2 and lk.LookupType not in (2, 9): continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for a, ps in zip(cov, st.PairSet):
                    for pv in ps.PairValueRecord:
                        v = pv.Value1.XAdvance if pv.Value1 and hasattr(pv.Value1, "XAdvance") else 0
                        pairs.setdefault((a, pv.SecondGlyph), v or 0)
            elif st.Format == 2:
                c1, c2 = st.ClassDef1.classDefs, st.ClassDef2.classDefs
                return_pairs = (cov, c1, c2, st.Class1Record)
                pairs.setdefault("__cls__", []).append(return_pairs)
    return pairs

def kern(f, pairs, a, b):
    if (a, b) in pairs: return pairs[(a, b)]
    for cov, c1, c2, recs in pairs.get("__cls__", []):
        if a in cov:
            r = recs[c1.get(a, 0)].Class2Record[c2.get(b, 0)]
            v = getattr(r.Value1, "XAdvance", 0) if r.Value1 else 0
            if v: return v
    return 0

def word(text, w, size, tracking_em):
    """Returns (svg path d, ink bbox, pen advance) for `text` at font-size `size` px, baseline y=0."""
    f = font(w); upm = f["head"].unitsPerEm; s = size / upm
    cmap = f.getBestCmap(); gs = f.getGlyphSet(); hm = f["hmtx"]; pairs = kern_pairs(f)
    names = [cmap[ord(ch)] for ch in text]
    x = 0.0; d = []; bp = None
    xmin = ymin = 1e9; xmax = ymax = -1e9
    for i, n in enumerate(names):
        pen = SVGPathPen(gs, ntos=lambda v: ("%.2f" % v).rstrip("0").rstrip("."))
        tp = TransformPen(pen, (s, 0, 0, -s, x, 0))
        gs[n].draw(tp); d.append(pen.getCommands())
        b = BoundsPen(gs); gs[n].draw(TransformPen(b, (s, 0, 0, -s, x, 0)))
        if b.bounds:
            xmin, ymin = min(xmin, b.bounds[0]), min(ymin, b.bounds[1]); xmax, ymax = max(xmax, b.bounds[2]), max(ymax, b.bounds[3])
        x += hm[n][0] * s + tracking_em * size
        if i + 1 < len(names): x += kern(f, pairs, n, names[i + 1]) * s
    return " ".join(d), (xmin, ymin, xmax, ymax), x

def diamond(cx, cy, side):
    h = side * 2 ** 0.5 / 2
    return f"M{cx:.2f} {cy - h:.2f}L{cx + h:.2f} {cy:.2f}L{cx:.2f} {cy + h:.2f}L{cx - h:.2f} {cy:.2f}Z"

def mark(size, w=300, tracking=-0.03, dia=0.0647, gap=0.047):
    """Wordmark geometry at font-size `size`: text path, diamond path, ink bbox (baseline at 0)."""
    d, (x0, y0, x1, y1), adv = word("akea", w, size, tracking)
    if not dia: return d, None, (x0, y0, x1, y1)
    side = dia * size
    cx = adv + gap * size + side / 2          # the diamond's box sits on the baseline (CSS baseline of an empty block)
    cy = -side / 2
    h = side * 2 ** 0.5 / 2
    return d, diamond(cx, cy, side), (x0, min(y0, cy - h), max(x1, cx + h), max(y1, cy + h))

def wordmark_svg(fg, accent, name, size=170, pad=0):
    d, dd, (x0, y0, x1, y1) = mark(size)
    W, H = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0 - pad:.2f} {y0 - pad:.2f} {W:.2f} {H:.2f}" width="{W:.0f}" height="{H:.0f}" role="img" aria-label="akea">'
           f'<path fill="{fg}" d="{d}"/><path fill="{accent}" d="{dd}"/></svg>')
    open(os.path.join(OUT, name), "w").write(svg)
    return W, H

def icon_svg(name, px, radius, w, size, dia, tracking, lift, full_bleed=False, bg=FOREST, fg=CREAM, accent=GOLD, safe=1.0):
    """App icon: forest square, cream wordmark, centred on the ink box (lifted a little like the kit's padding-bottom)."""
    d, dd, (x0, y0, x1, y1) = mark(size * safe, w=w, tracking=tracking, dia=dia, gap=dia and 0.047 or 0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    tx, ty = px / 2 - cx, px / 2 - cy - lift * safe
    r = 0 if full_bleed else radius
    rect = f'<rect width="{px}" height="{px}" rx="{r}" fill="{bg}"/>' if bg else ""
    parts = f'<path fill="{fg}" d="{d}"/>' + (f'<path fill="{accent}" d="{dd}"/>' if dd else "")
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {px} {px}" width="{px}" height="{px}">{rect}'
           f'<g transform="translate({tx:.2f} {ty:.2f})">{parts}</g></svg>')
    open(os.path.join(OUT, name), "w").write(svg)

# wordmarks (kit: 170px weight 300; diamond 11px; gap 8px)
print("wordmark", wordmark_svg(FOREST, BRONZE, "wordmark.svg"))
print("wordmark-light", wordmark_svg(CREAM, GOLD, "wordmark-light.svg"))
# app icon (kit: 120px square, radius 27, weight 500, 42px, diamond 3px, gap 2px, lift 3px)
icon_svg("icon-rounded.svg", 120, 27, 500, 42, 3 / 42, -0.03, 3)
icon_svg("icon-full.svg", 120, 0, 500, 42, 3 / 42, -0.03, 3, full_bleed=True)
# medium icon (64px, radius 15, weight 600, 23px, no diamond)
icon_svg("icon-64.svg", 64, 15, 600, 23, 0, -0.02, 1.5)
# favicon (32px, radius 8, weight 700, 12.5px, no diamond)
icon_svg("favicon.svg", 32, 8, 700, 12.5, 0, 0, 1)
# PWA maskable (content inside the 80% safe circle) and Android adaptive foreground (66% safe zone, transparent)
icon_svg("icon-maskable.svg", 120, 0, 500, 42, 3 / 42, -0.03, 3, full_bleed=True, safe=0.82)
icon_svg("adaptive-fg.svg", 120, 0, 500, 42, 3 / 42, -0.03, 3, bg=None, safe=0.66)
# splash (light wordmark on transparent, background colour set in app.json)
icon_svg("splash.svg", 400, 0, 300, 120, 0.0647, -0.03, 4, bg=None)
print("done")
