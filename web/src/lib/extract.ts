// Turns document text into fields: invoices (vendor, number, dates, total) and hotel night-audit reports.
import { parseAmount, parseDate } from "./parse";

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
export type ReportGuess = { values: ReportValues; deposits: Record<string, number>; business_date: string | null; confidence: number; notes: string[] };

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
