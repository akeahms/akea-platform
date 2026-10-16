// Prints checks onto PRE-PRINTED check stock (the bank's routing/account line is already on the paper, so no bank numbers
// are stored or printed). Layouts follow standard US business check stock on Letter paper, 3.5" per panel:
//   voucher_top     check · stub · stub        voucher_middle  stub · check · stub
//   voucher_bottom  stub · stub · check        standard3       check · check · check
// Every field moves by the bank account's alignment offset (inches) so each printer can be lined up once.
import type { CheckLayout } from "./books";

export type PrintCheck = {
  number: number | null; date: string; payee: string; address: string | null; amount: number; memo: string | null;
  // stub detail: bills paid (invoice, date, amount) or expense lines (account, memo, amount)
  stub: { left: string; mid?: string; amount: number }[];
  bankName: string;
};
export type CheckOptions = { layout: CheckLayout; offsetX: number; offsetY: number; company?: { name: string; address: string[] } | null; sample?: boolean };

// Standard PDF fonts only cover WinAnsi
const clean = (s: unknown) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E -ÿ–—•]/g, "");
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? "-" + ONES[r % 10].toLowerCase() : "");
  return [h ? `${ONES[h]} hundred` : "", rest && h ? rest.toLowerCase() : rest].filter(Boolean).join(" ");
}
/** 1234.56 → "One thousand two hundred thirty-four and 56/100" (dollars as words, cents as a fraction, the way checks are written). */
export function amountInWords(v: number): string {
  const cents = Math.round(v * 100);
  if (!Number.isFinite(v) || cents < 0) throw new Error("Invalid amount");
  let d = Math.floor(cents / 100);
  const c = cents % 100;
  if (d === 0) return `Zero and ${String(c).padStart(2, "0")}/100`;
  const parts: string[] = [];
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"], [1, ""]] as [number, string][]) {
    const chunk = Math.floor(d / size);
    if (chunk) { parts.push(under1000(chunk) + (name ? ` ${name}` : "")); d -= chunk * size; }
  }
  const words = parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} and ${String(c).padStart(2, "0")}/100`;
}
/** "2619 Gravel Dr, Fort Worth, TX 76102" → ["2619 Gravel Dr", "Fort Worth, TX 76102"]; multi-line addresses stay as typed. */
export function addressLines(a: string): string[] {
  const lines = a.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (lines.length === 1 && (lines[0].match(/,/g) || []).length >= 2) { const i = lines[0].indexOf(","); return [lines[0].slice(0, i).trim(), lines[0].slice(i + 1).trim()]; }
  return lines;
}
const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usDate = (s: string) => { const [y, m, d] = s.split("-"); return `${m}/${d}/${y}`; };

// panel order per layout (each panel is 3.5" tall, from the top of the page)
const PANELS: Record<CheckLayout, ("check" | "stub")[]> = {
  voucher_top: ["check", "stub", "stub"], voucher_middle: ["stub", "check", "stub"], voucher_bottom: ["stub", "stub", "check"], standard3: ["check", "check", "check"],
};
export const LAYOUT_LABEL: Record<CheckLayout, string> = {
  voucher_top: "Voucher · check on top", voucher_middle: "Voucher · check in the middle", voucher_bottom: "Voucher · check at the bottom", standard3: "Standard · 3 checks per page",
};

export async function buildChecksPdf(checks: PrintCheck[], o: CheckOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(o.sample ? "Check alignment test" : `Checks ${checks.map((c) => c.number).filter(Boolean).join(", ")}`);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0), grey = rgb(0.45, 0.45, 0.45), guide = rgb(0.75, 0.75, 0.75);
  const IN = 72, PH = 792, PANEL = 3.5 * IN;
  const ox = o.offsetX * IN, oy = o.offsetY * IN;   // + moves right / down
  const panels = PANELS[o.layout];
  const perPage = o.layout === "standard3" ? 3 : 1;
  const fit = (s: string, f: any, size: number, w: number) => { let t = clean(s); while (t && f.widthOfTextAtSize(t, size) > w) t = t.slice(0, -1); return t; };

  for (let i = 0; i < checks.length; i += perPage) {
    const page = doc.addPage([612, PH]);
    // text at (x, y) inches inside the panel that starts `top` inches from the page top
    const T = (top: number, x: number, y: number, s: string, size = 10, f = font, color = ink, maxW = 7.6) =>
      page.drawText(fit(s, f, size, maxW * IN), { x: x * IN + ox, y: PH - (top + y) * IN - oy, size, font: f, color });
    const R = (top: number, xRight: number, y: number, s: string, size = 10, f = font, color = ink) => {
      const t = clean(s); page.drawText(t, { x: xRight * IN - f.widthOfTextAtSize(t, size) + ox, y: PH - (top + y) * IN - oy, size, font: f, color });
    };
    let n = 0;
    panels.forEach((kind, p) => {
      const top = p * 3.5;
      if (kind === "check") {
        const c = checks[i + n]; n++;
        if (!c) return;
        if (o.company && !o.sample) { T(top, 0.45, 0.42, o.company.name, 10, bold, ink, 3.8); o.company.address.slice(0, 3).forEach((l, k) => T(top, 0.45, 0.6 + k * 0.16, l, 8.5, font, ink, 3.8)); }
        T(top, 6.55, 0.95, usDate(c.date), 10.5);
        T(top, 1.05, 1.47, c.payee, 11, bold, ink, 5.2);
        T(top, 6.85, 1.47, `**${money(c.amount)}`, 11, bold);
        const words = amountInWords(c.amount);
        T(top, 0.4, 1.85, (words + " " + "*".repeat(120)), 10, font, ink, 6.25);
        (c.address ? [c.payee, ...addressLines(c.address)] : []).slice(0, 4)
          .forEach((l, k) => T(top, 1.05, 2.22 + k * 0.17, l, 9.5, font, ink, 3.6));
        if (c.memo) T(top, 0.62, 2.98, c.memo, 9, font, ink, 3.2);
        if (o.sample) {
          // plain-paper alignment test: hold it over a blank check to see where everything lands
          page.drawRectangle({ x: 0.25 * IN, y: PH - (top + 3.4) * IN, width: 8 * IN, height: 3.3 * IN, borderColor: guide, borderWidth: 0.6, borderDashArray: [4, 3] });
          T(top, 0.45, 0.25, "ALIGNMENT TEST — print on plain paper and hold it against a blank check", 8, bold, grey);
        }
      } else {
        const c = checks[i];
        if (!c) return;
        T(top, 0.45, 0.45, c.payee, 10.5, bold, ink, 4.5);
        R(top, 8.05, 0.45, `${usDate(c.date)}${c.number ? `   Check ${c.number}` : ""}`, 10, bold);
        T(top, 0.45, 0.8, "Detail", 8, bold, grey); R(top, 8.05, 0.8, "Amount", 8, bold, grey);
        const rows = c.stub.slice(0, 11);
        rows.forEach((r, k) => {
          T(top, 0.45, 1.02 + k * 0.17, r.left, 9, font, ink, 4.2);
          if (r.mid) T(top, 4.8, 1.02 + k * 0.17, r.mid, 9, font, ink, 2.1);
          R(top, 8.05, 1.02 + k * 0.17, money(r.amount), 9);
        });
        if (c.stub.length > 11) T(top, 0.45, 1.02 + 11 * 0.17, `… and ${c.stub.length - 11} more`, 8.5, font, grey);
        T(top, 0.45, 3.2, c.bankName, 9, font, grey, 4); if (c.memo) T(top, 3.6, 3.2, c.memo, 9, font, grey, 2.6);
        R(top, 8.05, 3.2, money(c.amount), 10.5, bold);
      }
    });
  }
  return doc.save();
}

/** One sample check (and stubs) with every field filled, for lining up the printer. */
export const SAMPLE_CHECK: PrintCheck = {
  number: 1234, date: new Date().toISOString().slice(0, 10), payee: "Sample Payee Company LLC", address: "123 Main Street\nSuite 400\nFort Worth, TX 76102",
  amount: 12345.67, memo: "Alignment test", bankName: "Operating account",
  stub: [{ left: "Invoice 1001", mid: "10/01/2026", amount: 10000 }, { left: "Invoice 1002", mid: "10/08/2026", amount: 2345.67 }],
};
