// Small report-style PDF writer on top of pdf-lib: headings, key/value blocks, paragraphs and tables with page breaks.
export type Block =
  | { h: string }
  | { p: string; size?: number; muted?: boolean }
  | { kv: [string, string][] }
  | { table: { head: string[]; rows: (string | number | null | undefined)[][]; widths?: number[]; align?: ("l" | "r")[] } }
  | { space: number };

// Standard PDF fonts only cover WinAnsi; swap anything else for a close ASCII equivalent.
const clean = (s: unknown) => String(s ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/−/g, "-").replace(/[≤]/g, "<=").replace(/[≥]/g, ">=")
  .replace(/[→]/g, "->").replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—•…€™]/g, "");

export async function buildPdf(opts: { title: string; subtitle?: string; brand?: string; blocks: Block[]; accent?: string }): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(clean(opts.title));
  doc.setProducer("Akea Hotel Operations Platform");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
  const ink = hex("#14241F"), muted = hex("#5F5A51"), line = hex("#E6DFD3"), accent = hex(opts.accent || "#9C7A43"), zebra = hex("#F7F4EE");
  const W = 612, H = 792, M = 50, CW = W - 2 * M;
  let page = doc.addPage([W, H]);
  let y = H - M;
  let pageNo = 1;
  const footer = () => {
    page.drawText(clean(`${opts.brand || ""}  ·  ${opts.title}`), { x: M, y: 28, size: 8, font, color: muted });
    page.drawText(`Page ${pageNo}`, { x: W - M - 40, y: 28, size: 8, font, color: muted });
  };
  const newPage = () => { footer(); page = doc.addPage([W, H]); pageNo++; y = H - M; };
  const need = (h: number) => { if (y - h < 50) newPage(); };
  const wrap = (text: string, f: any, size: number, width: number) => {
    const words = clean(text).split(/\s+/); const out: string[] = []; let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > width && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };
  const fit = (text: string, f: any, size: number, width: number) => {
    let t = clean(text);
    while (t.length > 1 && f.widthOfTextAtSize(t, size) > width) t = t.slice(0, -2) + "…";
    return t;
  };
  // title block
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: accent });
  if (opts.brand) { page.drawText(clean(opts.brand.toUpperCase()), { x: M, y, size: 8.5, font: bold, color: accent }); y -= 20; }
  for (const l of wrap(opts.title, bold, 20, CW)) { page.drawText(l, { x: M, y: y - 4, size: 20, font: bold, color: ink }); y -= 25; }
  if (opts.subtitle) { page.drawText(clean(opts.subtitle), { x: M, y: y - 2, size: 10, font, color: muted }); y -= 20; }
  y -= 6;
  for (const b of opts.blocks) {
    if ("space" in b) { y -= b.space; continue; }
    if ("h" in b) {
      need(40); y -= 10;
      page.drawText(clean(b.h), { x: M, y: y - 12, size: 12.5, font: bold, color: ink });
      y -= 18; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: line }); y -= 10;
    } else if ("p" in b) {
      const size = b.size || 9.5;
      for (const l of wrap(b.p, font, size, CW)) { need(size + 4); page.drawText(l, { x: M, y: y - size, size, font, color: b.muted ? muted : ink }); y -= size + 4; }
      y -= 4;
    } else if ("kv" in b) {
      for (const [k, v] of b.kv) {
        const lines = wrap(v || "—", font, 9.5, CW - 180);
        need(lines.length * 13 + 4);
        page.drawText(fit(k, bold, 9, 170), { x: M, y: y - 10, size: 9, font: bold, color: muted });
        lines.forEach((l, i) => page.drawText(l, { x: M + 180, y: y - 10 - i * 13, size: 9.5, font, color: ink }));
        y -= lines.length * 13 + 4;
      }
      y -= 4;
    } else if ("table" in b) {
      const t = b.table;
      const n = t.head.length;
      const ws = t.widths ? t.widths.map((w) => (w / t.widths!.reduce((a, x) => a + x, 0)) * CW) : Array(n).fill(CW / n);
      const al = t.align || t.head.map((_, i) => (i === 0 ? "l" : "r"));
      const rowH = 15;
      const drawHead = () => {
        page.drawRectangle({ x: M, y: y - rowH, width: CW, height: rowH, color: zebra });
        let x = M;
        t.head.forEach((h, i) => {
          const s = fit(h, bold, 8, ws[i] - 8);
          const tw = bold.widthOfTextAtSize(s, 8);
          page.drawText(s, { x: al[i] === "r" ? x + ws[i] - 4 - tw : x + 4, y: y - 10.5, size: 8, font: bold, color: muted });
          x += ws[i];
        });
        y -= rowH;
      };
      need(rowH * 3); drawHead();
      t.rows.forEach((r, ri) => {
        if (y - rowH < 50) { newPage(); drawHead(); }
        let x = M;
        const isTotal = String(r[0] ?? "").toLowerCase().startsWith("total");
        r.forEach((c, i) => {
          const f = isTotal ? bold : font;
          const s = fit(String(c ?? ""), f, 8.5, ws[i] - 8);
          const tw = f.widthOfTextAtSize(s, 8.5);
          page.drawText(s, { x: al[i] === "r" ? x + ws[i] - 4 - tw : x + 4, y: y - 10.5, size: 8.5, font: f, color: ink });
          x += ws[i];
        });
        y -= rowH;
        page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.4, color: line });
        void ri;
      });
      y -= 10;
    }
  }
  footer();
  return doc.save();
}

export const money = (v: number | null | undefined, d = 0) =>
  v == null || isNaN(Number(v)) ? "" : (Number(v) < 0 ? "-$" : "$") + Math.abs(Number(v)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
