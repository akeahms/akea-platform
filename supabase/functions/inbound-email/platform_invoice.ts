// Reads a software invoice / receipt email (Stripe-style receipts from Supabase, Render, Postmark…, Apple, Google, Plaid…)
// into service, amount, currency, invoice number and date. Pure functions; unit-tested.
import { parseDate } from "./core.ts";

export type Svc = { id: string; name: string; match_terms: string[] };
export type PlatformGuess = {
  service_id: string | null; service_name: string | null; amount: number | null; currency: string;
  invoice_no: string | null; invoice_date: string | null; status: "paid" | "due"; confidence: number;
};

const CUR: [RegExp, string][] = [[/₹|\bINR\b|\bRs\.?/i, "INR"], [/€|\bEUR\b/i, "EUR"], [/£|\bGBP\b/i, "GBP"], [/\bCAD\b|CA\$/i, "CAD"], [/\$|\bUSD\b/i, "USD"]];
const MONEY = /(?:(?:US|CA)?\$|₹|€|£|\b(?:USD|INR|EUR|GBP|CAD|Rs\.?)\s?)\s?-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})*\.\d{2}\s?(?:USD|INR|EUR|GBP|CAD)\b/gi;
const toNum = (s: string) => { const v = parseFloat(s.replace(/[^\d.\-]/g, "")); return isFinite(v) ? Math.round(v * 100) / 100 : null; };
const curOf = (s: string) => (CUR.find(([re]) => re.test(s)) || [null, "USD"])[1];

/** Which service sent this invoice. Words in the sender's address count most; a tie means "not sure" (null). */
export function matchService(svcs: Svc[], from: string, subject: string, text: string, ignore: string[] = []): Svc | null {
  let hay = `${subject}\n${text.slice(0, 6000)}`.toLowerCase();
  let sender = from.toLowerCase();
  for (const x of ignore.filter(Boolean)) { hay = hay.split(x.toLowerCase()).join(" "); sender = sender.split(x.toLowerCase()).join(" "); }
  // a forwarded message names the original sender in its body ("From: Supabase <billing@supabase.io>")
  const fwd = hay.match(/(?:^|\n)\s*from:\s*([^\n]+)/);
  const senders = `${sender} ${fwd ? fwd[1] : ""}`;
  const scored = svcs.map((s) => {
    let score = 0;
    for (const t of s.match_terms || []) {
      const term = t.toLowerCase().trim();
      if (!term) continue;
      if (senders.includes(term)) score += 3;
      else if (hay.includes(term)) score += 1;
    }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].s;
}

const LABELS: RegExp[] = [
  /amount\s+paid|total\s+paid|amount\s+charged|total\s+charged|payment\s+amount|you\s+paid|charged\s+to/i,
  /amount\s+due|total\s+due|balance\s+due|invoice\s+total|grand\s+total|total\s+amount|order\s+total/i,
  /^\s*total\b(?!\s*(?:excl|before|tax))/i,
];
function dateIn(s: string): string | null {
  const m = s.match(/([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,8}\.?,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "").replace(/\s+/g, " ");
  const dm = raw.match(/^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/);           // 1 October 2026
  return parseDate(dm ? `${dm[2]} ${dm[1]} ${dm[3]}` : raw.replace(/^([A-Za-z]+)\.? (\d{1,2}) (\d{4})$/, "$1 $2, $3"));
}

export function parsePlatformInvoice(text: string, subject: string): Omit<PlatformGuess, "service_id" | "service_name"> {
  const all = `${subject}\n${text}`;
  const ls = all.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let amount: number | null = null, currency = "USD", conf = 0;
  for (const re of LABELS) {
    for (let i = 0; i < ls.length && amount == null; i++) {
      const m = ls[i].match(re);
      if (!m) continue;
      // the figure is on the same line after the label, or on the next line (HTML receipts put it below)
      const after = ls[i].slice((m.index || 0) + m[0].length);
      const hit = after.match(MONEY) || (ls[i + 1] || "").match(MONEY);
      if (hit) { amount = toNum(hit[0]); currency = curOf(hit[0]); conf += 0.5; }
    }
    if (amount != null) break;
  }
  if (amount == null) {
    // "$25.00 paid on October 1, 2026" (Stripe receipt headline)
    const m = all.match(new RegExp(`(${MONEY.source})\\s+(?:paid|charged)`, "i"));
    if (m) { amount = toNum(m[1]); currency = curOf(m[1]); conf += 0.4; }
  }
  if (amount == null) {
    const distinct = [...new Set((all.match(MONEY) || []).map((x) => `${curOf(x)}${toNum(x)}`))];
    if (distinct.length === 1) { const x = all.match(MONEY)![0]; amount = toNum(x); currency = curOf(x); conf += 0.25; }
  }
  const invoice_no = (all.match(/(?:invoice|receipt|order|bill)\s*(?:number|no\.?|#|id)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,})/i)
    || all.match(/\b(INV[-_ ]?[0-9][A-Z0-9\-]{2,})\b/)
    || all.match(/\binvoice\s+([A-Z]{0,4}-?\d[A-Z0-9\-]{3,})/i)
    || all.match(/#\s?([A-Z0-9]{3,}-[A-Z0-9\-]{2,}|\d{4,})/i))?.[1] || null;
  if (invoice_no) conf += 0.2;
  let invoice_date: string | null = null;
  for (let i = 0; i < ls.length && !invoice_date; i++) {
    if (/date\s+paid|paid\s+on|invoice\s+date|date\s+of\s+issue|date\s+issued|issue\s+date|billing\s+date|receipt\s+date|order\s+date|^date\b|^paid\b/i.test(ls[i]))
      invoice_date = dateIn(ls[i]) || (ls[i].length < 30 ? dateIn(ls[i + 1] || "") : null);   // label on one line, date on the next
  }
  if (!invoice_date) invoice_date = dateIn(all);
  if (invoice_date) conf += 0.2;
  const due = /amount\s+due|balance\s+due|payment\s+due|due\s+date|pay\s+by/i.test(all) && !/amount\s+paid|receipt|payment\s+received|thank you for your payment|paid\s+on/i.test(all);
  return { amount: amount != null ? Math.abs(amount) : null, currency, invoice_no, invoice_date, status: due ? "due" : "paid", confidence: Math.min(1, Math.round(conf * 100) / 100) };
}

export function readPlatformInvoice(svcs: Svc[], from: string, subject: string, text: string, ignore: string[] = []): PlatformGuess {
  const svc = matchService(svcs, from, subject, text, ignore);
  const p = parsePlatformInvoice(text, subject);
  return { service_id: svc?.id || null, service_name: svc?.name || null, ...p, confidence: svc ? p.confidence : Math.min(p.confidence, 0.4) };
}
