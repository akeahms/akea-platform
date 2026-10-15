// Turns document text into fields: invoices (vendor, number, dates, total) and hotel night-audit reports.
import { parseAmount, parseDate } from "./core.ts";

const NUM = /-?\(?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|-?\d+(?:\.\d+)?/g;
const lines = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

/** First number on the first line that matches `label` (and none of `not`). Night-audit layouts put Today before MTD/YTD. */
function valueAfter(ls: string[], label: RegExp, not?: RegExp, pick = 0): number | null {
  for (const l of ls) {
    const m = l.match(label);
    if (!m || (not && not.test(l))) continue;
    const rest = l.slice((m.index || 0) + m[0].length);
    const nums = (rest.match(NUM) || []).map(parseAmount).filter((v): v is number => v !== null);
    if (nums.length > pick) return nums[pick];
  }
  return null;
}

// ---------------- invoices ----------------
export type InvoiceGuess = { vendor_id: string | null; vendor_name: string | null; invoice_no: string | null; invoice_date: string | null; due_date: string | null; amount: number | null; confidence: number };
export function extractInvoice(text: string, vendors: { id: string; name: string }[]): InvoiceGuess {
  const ls = lines(text);
  const low = text.toLowerCase();
  const vendor = vendors
    .map((v) => ({ v, hit: low.indexOf(v.name.toLowerCase().split(/[\s/]+/)[0]) }))
    .filter((x) => x.hit >= 0 && x.v.name.length > 2)
    .sort((a, b) => a.hit - b.hit)[0]?.v || null;
  const invNo = text.match(/invoice\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i)?.[1] || text.match(/\b(INV[-\s]?\d{3,})\b/i)?.[1] || null;
  const dateNear = (re: RegExp) => {
    for (const l of ls) if (re.test(l)) {
      const m = l.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4})/);
      if (m) return parseDate(m[1]);
    }
    return null;
  };
  const invoice_date = dateNear(/invoice\s*date|date\s*of\s*invoice|^date\b|bill\s*date/i);
  let due_date = dateNear(/due\s*date|payment\s*due|due\s*by/i);
  const terms = text.match(/net\s*(\d{1,3})/i);
  if (!due_date && invoice_date && terms) {
    const d = new Date(invoice_date + "T12:00:00");
    d.setDate(d.getDate() + +terms[1]);
    due_date = d.toISOString().slice(0, 10);
  }
  const amount = valueAfter(ls, /(amount\s*due|balance\s*due|total\s*due|invoice\s*total|grand\s*total|total\s*amount)/i)
    ?? valueAfter(ls, /^total\b/i, /sub\s*total|tax/i);
  const found = [vendor, invNo, invoice_date, amount].filter((x) => x != null).length;
  return { vendor_id: vendor?.id || null, vendor_name: vendor?.name || null, invoice_no: invNo, invoice_date, due_date, amount: amount != null ? Math.abs(amount) : null, confidence: found / 4 };
}

// ---------------- night audit / daily reports ----------------
export type ReportValues = {
  rooms_available?: number; rooms_sold?: number; out_of_order?: number; comp_rooms?: number; no_shows?: number;
  arrivals?: number; departures?: number; in_house_guests?: number; room_revenue?: number; fnb_revenue?: number; other_revenue?: number;
};
export type Period = { rooms_available?: number; rooms_sold?: number; room_revenue?: number; total_revenue?: number };
export type Segment = { segment: string; rooms?: number; revenue?: number; rooms_mtd?: number; revenue_mtd?: number; rooms_ly_mtd?: number; revenue_ly_mtd?: number;
  rooms_ytd?: number; revenue_ytd?: number; rooms_ly_ytd?: number; revenue_ly_ytd?: number };
export type ReportExtra = { tax_total?: number; periods?: Record<string, Period>; segments?: Segment[]; format?: string; property_code?: string };
export type ReportGuess = { values: ReportValues; deposits: Record<string, number>; business_date: string | null; confidence: number; notes: string[]; extra?: ReportExtra };

// ---------------- Hilton OnQ "Final Audit" (exact layout) ----------------
type Row = { label: string; nums: number[] };
const HEADER_NOISE = /^(charge type|actual today|name|type|tax type|category|transferred|adjusted|ledger name|cash|card|other|direct bill)\b/i;
/** Turns a section's lines into labelled rows, re-joining labels the PDF wrapped above/below the numbers. */
function sectionRows(ls: string[]): Row[] {
  const out: (Row & { wrapped?: boolean })[] = [];
  let pending: string[] = [];
  let attach: (Row & { wrapped?: boolean }) | null = null;
  for (const l of ls) {
    const toks = l.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean);
    const isNum = (t: string) => parseAmount(t.replace(/\s*%$/, "")) !== null;
    const firstNum = toks.findIndex(isNum);
    if (firstNum < 0) {
      if (/actual today|opening balance/i.test(l) || /^(charge type|name|type|tax type|category|transferred|adjusted|ledger name|tax type category)$/i.test(l.trim())) { pending = []; attach = null; continue; }
      if (attach) { attach.label += " " + l.trim(); attach = null; } else pending.push(l.trim());
      continue;
    }
    const inline = toks.slice(0, firstNum).join(" ");
    if (HEADER_NOISE.test(inline) && /actual today/i.test(l)) { pending = []; continue; }
    const nums = toks.slice(firstNum).map((t) => parseAmount(t.replace(/\s*%$/, ""))!).filter((v) => v !== null);
    const row = { label: [...pending, inline].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(), nums, wrapped: pending.length > 0 };
    out.push(row);
    attach = row.wrapped ? row : null;
    pending = [];
  }
  return out;
}
const SECTIONS = ["Room Revenue", "Other Room Revenue", "Charges", "Revenue & Charges", "Taxes", "Payments", "Cash Deposit And Cash Drop", "Statistical Counts",
  "Occupancy", "Revenue Statistics", "Statistics by Market Segment", "Revenue by Market Segment", "Balance Information", "Turn Away Information"];
export function extractHiltonFinalAudit(text: string, rooms: number): ReportGuess | null {
  // keep the column gaps (two or more spaces) — they separate labels from numbers
  const ls = text.split(/\r?\n/).map((l) => l.replace(/\t/g, "  ").trim()).filter(Boolean);
  if (!ls.some((l) => /^final audit$/i.test(l)) || !ls.some((l) => /^statistical counts$/i.test(l))) return null;
  // section boundaries: a line that is exactly a known heading (first time for the revenue sections)
  const idx: [string, number][] = [];
  ls.forEach((l, i) => { const h = SECTIONS.find((s) => s.toLowerCase() === l.toLowerCase()); if (h && !idx.some(([n]) => n === h)) idx.push([h, i]); });
  const sec = (name: string) => {
    const at = idx.findIndex(([n]) => n === name);
    if (at < 0) return [] as Row[];
    const end = idx[at + 1]?.[1] ?? ls.length;
    return sectionRows(ls.slice(idx[at][1] + 1, end));
  };
  const totals = (rs: Row[]) => [...rs].reverse().find((r) => /^totals?$/i.test(r.label))?.nums || [];
  const find = (rs: Row[], re: RegExp) => rs.find((r) => re.test(r.label))?.nums;
  const roomR = totals(sec("Room Revenue")), otherRoom = totals(sec("Other Room Revenue"));
  const chargeRows = sec("Charges"), charges = totals(chargeRows);
  const taxRows = sec("Taxes"), taxes = totals(taxRows);
  const FNB = /suite shop|market|pantry|food|beverage|breakfast|vending|snack|restaurant|\bbar\b|minibar|coffee|lounge/i;
  // revenue columns: today(0) adj(1) adj-transferred(2) NET(3) MTD(4) LY-MTD(5) var(6) YTD(7) LY-YTD(8)
  const col = (r: number[] | undefined, i: number) => (r && r.length > i ? r[i] : 0);
  const sumRows = (rs: Row[], re: RegExp, i: number) => rs.filter((r) => re.test(r.label) && !/^totals?$/i.test(r.label)).reduce((a, r) => a + col(r.nums, i), 0);
  const recov = (i: number) => sumRows(taxRows, /recovery/i, i);
  const fnb = (i: number) => sumRows(chargeRows, FNB, i);
  const other = (i: number) => col(otherRoom, i) + col(charges, i) - fnb(i) + recov(i);
  const stats = sec("Statistical Counts");
  // stats columns: today(0) MTD(1) LY-MTD(2) YTD(3) LY-YTD(4)
  const st = (re: RegExp, i = 0) => col(find(stats, re), i);
  const values: ReportValues = {
    rooms_available: st(/^available rooms$/i) || rooms,
    rooms_sold: st(/^total sold rooms$/i),
    out_of_order: st(/^down rooms$/i),
    comp_rooms: st(/^complimentary rooms$/i),
    no_shows: st(/^no show$/i),
    arrivals: st(/^(arrivals|checked in reservations)$/i),
    departures: st(/^departed reservations$/i),
    in_house_guests: st(/^total guests$/i),
    room_revenue: round2(col(roomR, 3)),
    fnb_revenue: round2(fnb(3)),
    other_revenue: round2(other(3)),
  };
  const period = (si: number, ri: number): Period => ({
    rooms_available: st(/^available rooms$/i, si), rooms_sold: st(/^total sold rooms$/i, si),
    room_revenue: round2(col(roomR, ri)), total_revenue: round2(col(roomR, ri) + fnb(ri) + other(ri)),
  });
  const periods = { mtd: period(1, 4), ly_mtd: period(2, 5), ytd: period(3, 7), ly_ytd: period(4, 8) };
  // payments → expected bank deposits
  const pay = sec("Payments");
  const P: [string, RegExp][] = [["visa", /^visa$/i], ["mastercard", /^master/i], ["amex", /^amex|american express/i], ["discover", /^discover$/i], ["cash", /^cash$/i], ["direct_bill", /^bill to|direct bill/i]];
  const deposits: Record<string, number> = {};
  for (const [k, re] of P) { const v = pay.filter((r) => re.test(r.label)).reduce((a, r) => a + col(r.nums, 3), 0); if (v) deposits[k] = round2(v); }
  // market segments: today(0) adj(1) NET(2) MTD(3) LY-MTD(4) YTD(5) LY-YTD(6)
  const segR = sec("Statistics by Market Segment"), segV = sec("Revenue by Market Segment");
  const segments: Segment[] = segR.filter((r) => !/^totals?$/i.test(r.label)).map((r) => {
    const v = segV.find((x) => x.label.toLowerCase() === r.label.toLowerCase())?.nums;
    return { segment: titleCase(r.label), rooms: col(r.nums, 2), revenue: round2(col(v, 2)), rooms_mtd: col(r.nums, 3), revenue_mtd: round2(col(v, 3)),
      rooms_ly_mtd: col(r.nums, 4), revenue_ly_mtd: round2(col(v, 4)), rooms_ytd: col(r.nums, 5), revenue_ytd: round2(col(v, 5)), rooms_ly_ytd: col(r.nums, 6), revenue_ly_ytd: round2(col(v, 6)) };
  }).filter((s) => s.rooms_ytd || s.revenue_ytd || s.rooms || s.revenue);
  const notes: string[] = [];
  let conf = 0.5;
  if (values.rooms_sold && values.rooms_sold <= (values.rooms_available || rooms)) conf += 0.2; else notes.push("Rooms sold not found or larger than rooms available.");
  if (values.room_revenue && values.rooms_sold) { const adr = values.room_revenue / values.rooms_sold; if (adr > 30 && adr < 1500) conf += 0.2; else notes.push(`Average rate looks unusual (${adr.toFixed(2)}).`); }
  const revStat = stats.length ? 0.1 : 0; conf += revStat;
  if (values.rooms_available && rooms && Math.abs(values.rooms_available - rooms) > 1) notes.push(`Report shows ${values.rooms_available} rooms; the hotel is set up with ${rooms}.`);
  const dm = ls.slice(0, 6).join(" ").replace(/\s+/g, " ").match(/\bDate:\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const code = ls[1]?.match(/^([A-Z]{5})\b/)?.[1];
  return { values, deposits, business_date: dm ? parseDate(dm[1]) : null, confidence: Math.min(1, conf), notes,
    extra: { tax_total: round2(col(taxes, 3) - recov(3)), periods, segments, format: "Hilton OnQ Final Audit", property_code: code } };
}
const round2 = (v: number) => Math.round(v * 100) / 100;
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bSmerf\b/, "SMERF");

const R: [keyof ReportValues, RegExp, RegExp?][] = [
  ["rooms_sold", /(rooms?\s*(sold|occupied)|occupied\s*rooms|total\s*rooms\s*occupied|rooms\s*rented|paid\s*occupied)\b/i, /%|percent|comp|vacant|available/i],
  ["rooms_available", /(total\s*rooms|rooms?\s*available|available\s*rooms|room\s*inventory|physical\s*rooms)\b/i, /occupied|sold|%|out\s*of/i],
  ["out_of_order", /(out\s*of\s*order|o\.?o\.?o\.?\b|rooms?\s*ooo)/i],
  ["comp_rooms", /(comp(limentary)?\s*rooms?|complimentary)\b/i],
  ["no_shows", /no[\s\-]*shows?\b/i],
  ["arrivals", /(arrivals?|check[\s\-]*ins?)\b/i, /expected|tomorrow/i],
  ["departures", /(departures?|check[\s\-]*outs?)\b/i, /expected|tomorrow/i],
  ["in_house_guests", /(in[\s\-]*house\s*(guests|persons|people)|guests?\s*in[\s\-]*house|number\s*of\s*guests|total\s*guests)\b/i],
  ["room_revenue", /(room\s*revenue|rooms?\s*rev\b|total\s*room\s*revenue|room\s*charges?|guest\s*room\s*revenue)/i, /tax|adr|average|per\s*room/i],
  ["fnb_revenue", /(food\s*(and|&)\s*bev(erage)?|f\s*&\s*b\s*revenue|restaurant|market\s*(sales|pantry))/i, /tax/i],
  ["other_revenue", /(other\s*(revenue|income)|misc(ellaneous)?\s*(revenue|income)|parking|pet\s*fee|meeting\s*room)/i, /tax/i],
];
const PAY: [string, RegExp][] = [
  ["visa", /\bvisa\b/i], ["mastercard", /master\s*card|\bmc\b/i], ["amex", /amex|american\s*express/i], ["discover", /discover/i],
  ["cash", /\bcash\b/i], ["direct_bill", /direct\s*bill|city\s*ledger|a\/r\s*transfer/i], ["ota", /expedia\s*collect|booking\.com|virtual\s*card|\bvcc\b/i],
];

export function extractReport(text: string, rooms: number): ReportGuess {
  const exact = extractHiltonFinalAudit(text, rooms);
  if (exact) return exact;
  const ls = lines(text);
  const notes: string[] = [];
  const values: ReportValues = {};
  for (const [k, re, not] of R) {
    const v = valueAfter(ls, re, not);
    if (v !== null && v >= 0) (values as any)[k] = v;
  }
  // occupancy percentage can fill rooms sold when only % is printed
  if (values.rooms_sold == null) {
    const occ = valueAfter(ls, /occupancy\s*(%|percent(age)?)?/i, /forecast|tomorrow/i);
    if (occ != null && occ > 0 && occ <= 100) { values.rooms_sold = Math.round((rooms * occ) / 100); notes.push("Rooms sold worked out from occupancy %."); }
  }
  if (values.room_revenue == null && values.rooms_sold) {
    const adr = valueAfter(ls, /\b(adr|average\s*daily\s*rate|average\s*rate)\b/i);
    if (adr) { values.room_revenue = Math.round(adr * values.rooms_sold * 100) / 100; notes.push("Room revenue worked out from ADR × rooms sold."); }
  }
  if (values.rooms_available == null || values.rooms_available > rooms * 1.05 || values.rooms_available < rooms * 0.5) values.rooms_available = rooms;
  ["rooms_sold", "out_of_order", "comp_rooms", "no_shows", "arrivals", "departures", "in_house_guests"].forEach((k) => {
    const v = (values as any)[k];
    if (v != null) (values as any)[k] = Math.round(v);
  });
  // sanity checks
  let score = 0;
  if (values.rooms_sold != null && values.rooms_sold <= values.rooms_available!) score += 0.4;
  else if (values.rooms_sold != null) { notes.push("Rooms sold is more than rooms available — check the report."); score += 0.1; }
  if (values.room_revenue != null && values.rooms_sold) {
    const adr = values.room_revenue / values.rooms_sold;
    if (adr > 30 && adr < 1500) score += 0.4; else notes.push(`Average rate looks unusual (${adr.toFixed(2)}).`);
  } else if (values.room_revenue != null) score += 0.2;
  if (values.arrivals != null || values.departures != null) score += 0.1;
  if (values.out_of_order != null || values.no_shows != null) score += 0.1;
  const deposits: Record<string, number> = {};
  const settle = ls.findIndex((l) => /(payment|settlement|tender|credit\s*card)\s*(summary|totals?|breakdown)|payments?\s*by\s*type/i.test(l));
  const scope = settle >= 0 ? ls.slice(settle, settle + 40) : ls;
  for (const [k, re] of PAY) {
    const v = valueAfter(scope, re, /refund|tip|adjust/i);
    if (v != null && Math.abs(v) > 0) deposits[k] = Math.abs(v);
  }
  const dm = text.match(/(business|audit|report|for)\s*date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
  return { values, deposits, business_date: dm ? parseDate(dm[2]) : null, confidence: Math.min(1, score), notes };
}
