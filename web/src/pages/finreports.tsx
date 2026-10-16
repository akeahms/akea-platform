// Financial reports: the standard set an accountant expects, all from the books (journal), bills, checks and the bank.
// Every report: hotel + date filters, printable, CSV export. Row security decides what each person can see.
import React, { useMemo, useState } from "react";
import { db } from "../lib/sb";
import { Ctx, usd, fmtDate, todayIn, addDays } from "../lib/app";
import { PageHead, Card, Loading, ErrorBox, Empty, useAsync, HotelSelect, downloadFile, toCsv } from "../ui";
import { Gl, Vendor, Bill, BankAcct, useLookups, glLabel } from "../lib/books";

type Cell = string | number | null;
type Row = { cells: Cell[]; kind?: "section" | "total" | "grand" | "sub"; indent?: number };
type Out = { head: string[]; align?: ("l" | "r")[]; rows: Row[]; note?: string };
type Params = { hotels: string[] | null; from: string; to: string; account?: string };
type Lk = { gl: Gl[]; vendors: Vendor[] };
type Def = { id: string; group: string; name: string; desc: string; dates: "range" | "asof"; account?: boolean; run: (p: Params, lk: Lk, ctx: Ctx) => Promise<Out> };

const r2 = (v: number) => Math.round(v * 100) / 100;
const hq = (p: Params, col = "hotel_id") => (p.hotels ? `&${col}=in.(${p.hotels.join(",")})` : "");
const vName = (lk: Lk, id: string | null) => lk.vendors.find((v) => v.id === id)?.name || "(no vendor)";
const acctOf = (lk: Lk, id: string) => lk.gl.find((g) => g.id === id);
const nat = (g?: Gl) => (g && (g.type === "asset" || g.type === "expense") ? 1 : -1);   // natural sign: debit for assets/expenses
const SECTIONS: [string, (g: Gl) => boolean][] = [
  ["Assets", (g) => g.type === "asset"], ["Liabilities", (g) => g.type === "liability"], ["Equity", (g) => g.type === "equity"],
  ["Income", (g) => g.type === "revenue"], ["Expenses", (g) => g.type === "expense"],
];
async function balances(p: Params, from: string) {
  return db.rpc<{ hotel_id: string; account_id: string; opening: number; debit: number; credit: number }[]>("gl_balances", { p_from: from, p_to: p.to, p_hotels: p.hotels });
}
type JLine = { id: string; hotel_id: string; account_id: string; debit: number; credit: number; memo: string | null; entry_id: string; journal_entries: { entry_date: string; memo: string | null; source: string } };
async function lines(p: Params, extra = "") {
  return db.getAll<JLine>(`journal_lines?select=id,hotel_id,account_id,debit,credit,memo,entry_id,journal_entries!inner(entry_date,memo,source)&journal_entries.entry_date=gte.${p.from}&journal_entries.entry_date=lte.${p.to}${hq(p)}${extra}&order=id.asc`, 100000);
}
const SOURCE: Record<string, string> = { bank: "Bank", check: "Check", payment: "Bill payment", bill: "Bill", revenue: "Night audit", void: "Reversal", refund: "Refund", manual: "Journal entry" };
async function openBills(p: Params, asOf: string) {
  return db.getAll<Bill>(`bills?select=*&status=in.(approved,scheduled,pending_approval,paid)${hq(p)}&invoice_date=lte.${asOf}&order=due_date.asc,id.asc`, 20000)
    .then((bs) => bs.filter((b) => b.status !== "paid" || (b.paid_at && b.paid_at > asOf)));
}
const ageBucket = (due: string | null, asOf: string) => {
  if (!due) return 0;
  const d = Math.floor((Date.parse(asOf) - Date.parse(due)) / 864e5);
  return d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4;
};
const AGE_HEAD = ["Current", "1–30", "31–60", "61–90", "Over 90"];

// ---------------------------------------------------------------- report definitions
const DEFS: Def[] = [
  // ---- business overview
  { id: "pnl", group: "Business overview", name: "Profit and Loss", desc: "Income (from the night audit) and expenses for the period.", dates: "range", run: async (p) => {
    const rs = await db.rpc<any[]>("pnl", { p_from: p.from, p_to: p.to, p_hotels: p.hotels });
    const rev = rs.filter((r) => r.kind === "revenue"), exp = rs.filter((r) => r.kind === "expense");
    const S = (a: any[]) => r2(a.reduce((s, r) => s + Number(r.actual || 0), 0));
    const secs = [...new Set(exp.map((r) => r.section || "Expenses"))];
    return { head: ["Account", "Amount"], align: ["l", "r"], rows: [
      { cells: ["Income", null], kind: "section" }, ...rev.map((r) => ({ cells: [`${r.number} · ${r.account}`, Number(r.actual)], indent: 1 })),
      { cells: ["Total income", S(rev)], kind: "total" },
      { cells: ["Expenses", null], kind: "section" },
      ...secs.flatMap((sec) => [{ cells: [sec, null] as Cell[], kind: "sub" as const, indent: 1 }, ...exp.filter((r) => (r.section || "Expenses") === sec).map((r) => ({ cells: [`${r.number} · ${r.account}`, Number(r.actual)] as Cell[], indent: 2 }))]),
      { cells: ["Total expenses", S(exp)], kind: "total" },
      { cells: ["Net operating income", r2(S(rev) - S(exp))], kind: "grand" },
    ] };
  } },
  { id: "pnl_budget", group: "Business overview", name: "Profit and Loss vs Budget", desc: "Actual against budget and last year, with the difference.", dates: "range", run: async (p) => {
    const rs = await db.rpc<any[]>("pnl", { p_from: p.from, p_to: p.to, p_hotels: p.hotels });
    const row = (r: any) => { const a = Number(r.actual || 0), b = r.budget == null ? null : Number(r.budget); return [`${r.number} · ${r.account}`, a, b, b == null ? null : r2(a - b), r.last_year == null ? null : Number(r.last_year)] as Cell[]; };
    const rev = rs.filter((r) => r.kind === "revenue"), exp = rs.filter((r) => r.kind === "expense");
    const tot = (a: any[], k: string) => r2(a.reduce((s, r) => s + Number(r[k] || 0), 0));
    return { head: ["Account", "Actual", "Budget", "Over / (under)", "Last year"], align: ["l", "r", "r", "r", "r"], rows: [
      { cells: ["Income", null, null, null, null], kind: "section" }, ...rev.map((r) => ({ cells: row(r), indent: 1 })),
      { cells: ["Total income", tot(rev, "actual"), tot(rev, "budget"), r2(tot(rev, "actual") - tot(rev, "budget")), tot(rev, "last_year")], kind: "total" },
      { cells: ["Expenses", null, null, null, null], kind: "section" }, ...exp.map((r) => ({ cells: row(r), indent: 1 })),
      { cells: ["Total expenses", tot(exp, "actual"), tot(exp, "budget"), r2(tot(exp, "actual") - tot(exp, "budget")), tot(exp, "last_year")], kind: "total" },
      { cells: ["Net operating income", r2(tot(rev, "actual") - tot(exp, "actual")), r2(tot(rev, "budget") - tot(exp, "budget")), null, r2(tot(rev, "last_year") - tot(exp, "last_year"))], kind: "grand" },
    ] };
  } },
  { id: "pnl_month", group: "Business overview", name: "Profit and Loss by Month", desc: "Each month side by side (up to 12).", dates: "range", run: async (p) => {
    const months: [string, string][] = [];
    for (let d = p.from.slice(0, 7) + "-01"; d <= p.to && months.length < 12; ) {
      const end = addDays(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
      months.push([d < p.from ? p.from : d, end > p.to ? p.to : end]);
      d = addDays(end, 1);
    }
    const res = await Promise.all(months.map(([a, b]) => db.rpc<any[]>("pnl", { p_from: a, p_to: b, p_hotels: p.hotels })));
    const keys = new Map<string, { label: string; kind: string }>();
    res.flat().forEach((r) => keys.set(`${r.kind}|${r.number}|${r.account}`, { label: `${r.number} · ${r.account}`, kind: r.kind }));
    const val = (i: number, k: string) => Number(res[i].find((r) => `${r.kind}|${r.number}|${r.account}` === k)?.actual || 0);
    const tot = (i: number, kind: string) => r2(res[i].filter((r) => r.kind === kind).reduce((s, r) => s + Number(r.actual || 0), 0));
    const sec = (kind: string, title: string) => [{ cells: [title, ...months.map(() => null), null], kind: "section" as const },
      ...[...keys.entries()].filter(([, v]) => v.kind === kind).map(([k, v]) => ({ cells: [v.label, ...months.map((_, i) => val(i, k)), r2(months.reduce((s, _, i) => s + val(i, k), 0))] as Cell[], indent: 1 })),
      { cells: [`Total ${title.toLowerCase()}`, ...months.map((_, i) => tot(i, kind)), r2(months.reduce((s, _, i) => s + tot(i, kind), 0))], kind: "total" as const }];
    return { head: ["Account", ...months.map(([a]) => new Date(a + "T12:00:00Z").toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })), "Total"],
      align: ["l", ...months.map(() => "r" as const), "r"],
      rows: [...sec("revenue", "Income"), ...sec("expense", "Expenses"),
        { cells: ["Net operating income", ...months.map((_, i) => r2(tot(i, "revenue") - tot(i, "expense"))), r2(months.reduce((s, _, i) => s + tot(i, "revenue") - tot(i, "expense"), 0))], kind: "grand" }] };
  } },
  { id: "pnl_hotel", group: "Business overview", name: "Profit and Loss by Hotel", desc: "Each hotel side by side.", dates: "range", run: async (p, _lk, ctx) => {
    const hs = ctx.hotels.filter((h) => h.status === "operating" && (!p.hotels || p.hotels.includes(h.id)));
    const res = await Promise.all(hs.map((h) => db.rpc<any[]>("pnl", { p_from: p.from, p_to: p.to, p_hotels: [h.id] })));
    const t = (i: number, kind: string) => r2(res[i].filter((r) => r.kind === kind).reduce((s, r) => s + Number(r.actual || 0), 0));
    return { head: ["", ...hs.map((h) => h.name), "Total"], align: ["l", ...hs.map(() => "r" as const), "r"], rows: [
      { cells: ["Total income", ...hs.map((_, i) => t(i, "revenue")), r2(hs.reduce((s, _, i) => s + t(i, "revenue"), 0))], kind: "total" },
      { cells: ["Total expenses", ...hs.map((_, i) => t(i, "expense")), r2(hs.reduce((s, _, i) => s + t(i, "expense"), 0))], kind: "total" },
      { cells: ["Net operating income", ...hs.map((_, i) => r2(t(i, "revenue") - t(i, "expense"))), r2(hs.reduce((s, _, i) => s + t(i, "revenue") - t(i, "expense"), 0))], kind: "grand" },
    ] };
  } },
  { id: "bs", group: "Business overview", name: "Balance Sheet", desc: "What the hotels own and owe on a date.", dates: "asof", run: async (p, lk) => {
    const b = await balances(p, "1900-01-01");
    const by = new Map<string, number>();
    b.forEach((x) => by.set(x.account_id, (by.get(x.account_id) || 0) + Number(x.opening) + Number(x.debit) - Number(x.credit)));
    const rowsOf = (pred: (g: Gl) => boolean) => [...by.entries()].map(([id, v]) => ({ g: acctOf(lk, id)!, v })).filter((x) => x.g && pred(x.g) && Math.abs(x.v) >= 0.005)
      .sort((a, c) => a.g.number.localeCompare(c.g.number)).map((x) => ({ g: x.g, v: r2(x.v * nat(x.g)) }));
    const A = rowsOf((g) => g.type === "asset"), L = rowsOf((g) => g.type === "liability"), E = rowsOf((g) => g.type === "equity");
    const ni = r2(-[...by.entries()].filter(([id]) => ["revenue", "expense"].includes(acctOf(lk, id)?.type || "")).reduce((s, [, v]) => s + v, 0));
    const S = (xs: { v: number }[]) => r2(xs.reduce((s, x) => s + x.v, 0));
    const line = (x: { g: Gl; v: number }) => ({ cells: [glLabel(x.g), x.v] as Cell[], indent: 1 });
    return { head: ["Account", "Balance"], align: ["l", "r"], note: `As of ${fmtDate(p.to)}. Net income includes every period before this date that isn't closed to retained earnings.`, rows: [
      { cells: ["Assets", null], kind: "section" }, ...A.map(line), { cells: ["Total assets", S(A)], kind: "grand" },
      { cells: ["Liabilities", null], kind: "section" }, ...L.map(line), { cells: ["Total liabilities", S(L)], kind: "total" },
      { cells: ["Equity", null], kind: "section" }, ...E.map(line), { cells: ["Net income", ni], indent: 1 }, { cells: ["Total equity", r2(S(E) + ni)], kind: "total" },
      { cells: ["Total liabilities and equity", r2(S(L) + S(E) + ni)], kind: "grand" },
    ] };
  } },
  { id: "tb", group: "For your accountant", name: "Trial Balance", desc: "Debit and credit balance of every account; the two columns must agree.", dates: "asof", run: async (p, lk) => {
    const b = await balances(p, "1900-01-01");
    const by = new Map<string, number>();
    b.forEach((x) => by.set(x.account_id, (by.get(x.account_id) || 0) + Number(x.opening) + Number(x.debit) - Number(x.credit)));
    const rows = [...by.entries()].filter(([, v]) => Math.abs(v) >= 0.005).map(([id, v]) => ({ g: acctOf(lk, id), v })).filter((x) => x.g).sort((a, c) => a.g!.number.localeCompare(c.g!.number));
    const dr = r2(rows.reduce((s, x) => s + (x.v > 0 ? x.v : 0), 0)), cr = r2(rows.reduce((s, x) => s + (x.v < 0 ? -x.v : 0), 0));
    return { head: ["Account", "Debit", "Credit"], align: ["l", "r", "r"], rows: [...rows.map((x) => ({ cells: [glLabel(x.g), x.v > 0 ? r2(x.v) : null, x.v < 0 ? r2(-x.v) : null] as Cell[] })),
      { cells: ["Total", dr, cr], kind: "grand" }], note: dr === cr ? "In balance." : `Out of balance by ${usd(Math.abs(dr - cr), 2)}.` };
  } },
  { id: "cf", group: "Business overview", name: "Statement of Cash Flows", desc: "Cash in and out of the bank accounts, by what it was for.", dates: "range", run: async (p, lk) => {
    const bankIds = new Set(lk.gl.filter((g) => g.qbo_type === "Bank").map((g) => g.id));
    const [ls, b] = await Promise.all([lines(p), balances(p, p.from)]);
    const start = r2(b.filter((x) => bankIds.has(x.account_id)).reduce((s, x) => s + Number(x.opening), 0));
    const byEntry = new Map<string, JLine[]>();
    ls.forEach((l) => byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) || []), l]));
    const groups = new Map<string, Map<string, number>>([["Operating activities", new Map()], ["Investing activities", new Map()], ["Financing activities", new Map()]]);
    for (const es of byEntry.values()) {
      const cash = es.filter((l) => bankIds.has(l.account_id)).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
      if (!cash) continue;
      const others = es.filter((l) => !bankIds.has(l.account_id));
      const tot = others.reduce((s, l) => s + Math.abs(Number(l.debit) - Number(l.credit)), 0) || 1;
      for (const l of others) {
        const g = acctOf(lk, l.account_id); if (!g) continue;
        const grp = g.qbo_type === "Fixed Asset" ? "Investing activities" : g.type === "equity" || /loan|note|mortgage/i.test(g.name) ? "Financing activities" : "Operating activities";
        const share = cash * (Math.abs(Number(l.debit) - Number(l.credit)) / tot);
        const m = groups.get(grp)!; m.set(glLabel(g), (m.get(glLabel(g)) || 0) + share);
      }
    }
    const out: Row[] = [];
    let net = 0;
    for (const [grp, m] of groups) {
      const items = [...m.entries()].filter(([, v]) => Math.abs(v) >= 0.005).sort((a, c) => a[0].localeCompare(c[0]));
      const t = r2(items.reduce((s, [, v]) => s + v, 0)); net += t;
      out.push({ cells: [grp, null], kind: "section" }, ...items.map(([k, v]) => ({ cells: [k, r2(v)] as Cell[], indent: 1 })), { cells: [`Net cash from ${grp.toLowerCase()}`, t], kind: "total" });
    }
    return { head: ["", "Amount"], align: ["l", "r"], rows: [...out, { cells: ["Net change in cash", r2(net)], kind: "grand" }, { cells: ["Cash at start of period", start] }, { cells: ["Cash at end of period", r2(start + net)], kind: "grand" }] };
  } },
  // ---- what you owe
  { id: "ap_sum", group: "What you owe", name: "A/P Aging Summary", desc: "Unpaid bills by vendor and how overdue they are.", dates: "asof", run: async (p, lk) => {
    const bs = await openBills(p, p.to);
    const m = new Map<string, number[]>();
    bs.forEach((b) => { const k = b.vendor_id || ""; const a = m.get(k) || [0, 0, 0, 0, 0]; a[ageBucket(b.due_date, p.to)] += Number(b.amount); m.set(k, a); });
    const rows = [...m.entries()].map(([k, a]) => ({ cells: [vName(lk, k || null), ...a.map(r2), r2(a.reduce((s, v) => s + v, 0))] as Cell[] })).sort((a, b) => String(a.cells[0]).localeCompare(String(b.cells[0])));
    const col = (i: number) => r2([...m.values()].reduce((s, a) => s + a[i], 0));
    return { head: ["Vendor", ...AGE_HEAD, "Total"], align: ["l", "r", "r", "r", "r", "r", "r"], rows: [...rows, { cells: ["Total", ...[0, 1, 2, 3, 4].map(col), r2(bs.reduce((s, b) => s + Number(b.amount), 0))], kind: "grand" }] };
  } },
  { id: "ap_det", group: "What you owe", name: "A/P Aging Detail", desc: "Every unpaid bill with its due date and days past due.", dates: "asof", run: async (p, lk, ctx) => {
    const bs = await openBills(p, p.to);
    const out: Row[] = [];
    AGE_HEAD.forEach((h, i) => {
      const xs = bs.filter((b) => ageBucket(b.due_date, p.to) === i);
      if (!xs.length) return;
      out.push({ cells: [h, null, null, null, null, null], kind: "section" },
        ...xs.map((b) => ({ cells: [b.invoice_date ? fmtDate(b.invoice_date) : "", vName(lk, b.vendor_id), b.invoice_no, ctx.hotels.find((h2) => h2.id === b.hotel_id)?.name || "", b.due_date ? fmtDate(b.due_date) : "", Number(b.amount)] as Cell[], indent: 1 })),
        { cells: [`Total ${h}`, null, null, null, null, r2(xs.reduce((s, b) => s + Number(b.amount), 0))], kind: "total" });
    });
    return { head: ["Date", "Vendor", "Invoice", "Hotel", "Due", "Open balance"], align: ["l", "l", "l", "l", "l", "r"], rows: [...out, { cells: ["Total", null, null, null, null, r2(bs.reduce((s, b) => s + Number(b.amount), 0))], kind: "grand" }] };
  } },
  { id: "unpaid", group: "What you owe", name: "Unpaid Bills", desc: "Approved and waiting bills, oldest due first.", dates: "asof", run: async (p, lk, ctx) => {
    const bs = (await openBills(p, p.to)).filter((b) => b.status !== "paid");
    return { head: ["Due", "Vendor", "Invoice", "Hotel", "Status", "Amount"], align: ["l", "l", "l", "l", "l", "r"],
      rows: [...bs.map((b) => ({ cells: [b.due_date ? fmtDate(b.due_date) : "", vName(lk, b.vendor_id), b.invoice_no, ctx.hotels.find((h) => h.id === b.hotel_id)?.name || "", b.status.replace("_", " "), Number(b.amount)] as Cell[] })),
        { cells: ["Total", null, null, null, null, r2(bs.reduce((s, b) => s + Number(b.amount), 0))], kind: "grand" }] };
  } },
  { id: "billpay", group: "What you owe", name: "Bill Payment List", desc: "Bills paid in the period, how and when.", dates: "range", run: async (p, lk) => {
    const bs = await db.getAll<Bill>(`bills?select=*&status=eq.paid&paid_at=gte.${p.from}&paid_at=lte.${p.to}${hq(p)}&order=paid_at.asc,id.asc`, 20000);
    return { head: ["Paid", "Vendor", "Invoice", "Method", "Reference", "Amount"], align: ["l", "l", "l", "l", "l", "r"],
      rows: [...bs.map((b) => ({ cells: [fmtDate(b.paid_at!), vName(lk, b.vendor_id), b.invoice_no, (b.payment_method || "").toUpperCase(), b.payment_ref, Number(b.amount)] as Cell[] })),
        { cells: ["Total", null, null, null, null, r2(bs.reduce((s, b) => s + Number(b.amount), 0))], kind: "grand" }] };
  } },
  { id: "vend_bal", group: "What you owe", name: "Vendor Balance Summary", desc: "What is owed to each vendor.", dates: "asof", run: async (p, lk) => {
    const bs = (await openBills(p, p.to));
    const m = new Map<string, number>(); bs.forEach((b) => m.set(b.vendor_id || "", (m.get(b.vendor_id || "") || 0) + Number(b.amount)));
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ cells: [vName(lk, k || null), r2(v)] as Cell[] }));
    return { head: ["Vendor", "Balance"], align: ["l", "r"], rows: [...rows, { cells: ["Total", r2([...m.values()].reduce((s, v) => s + v, 0))], kind: "grand" }] };
  } },
  // ---- expenses & vendors
  { id: "exp_vendor", group: "Expenses and vendors", name: "Expenses by Vendor Summary", desc: "Spend per vendor: bills plus bank and check payments.", dates: "range", run: async (p, lk) => {
    const [bs, tx, ck] = await Promise.all([
      db.getAll<Bill>(`bills?select=vendor_id,amount,invoice_date,status&status=in.(approved,scheduled,paid)&invoice_date=gte.${p.from}&invoice_date=lte.${p.to}${hq(p)}&order=id.asc`, 20000),
      db.getAll<any>(`bank_transactions?select=vendor_id,amount&status=eq.posted&amount=lt.0&matched_kind=eq.gl&posted_date=gte.${p.from}&posted_date=lte.${p.to}${hq(p)}&order=id.asc`, 20000),
      db.getAll<any>(`checks?select=payee_vendor_id,payee_name,amount,bill_ids&status=neq.voided&check_date=gte.${p.from}&check_date=lte.${p.to}${hq(p)}&order=id.asc`, 20000),
    ]);
    const m = new Map<string, number>();
    const add = (k: string, v: number) => m.set(k, (m.get(k) || 0) + v);
    bs.forEach((b: any) => add(vName(lk, b.vendor_id), Number(b.amount)));
    tx.forEach((t) => add(vName(lk, t.vendor_id), -Number(t.amount)));
    ck.filter((c) => !c.bill_ids?.length).forEach((c) => add(c.payee_vendor_id ? vName(lk, c.payee_vendor_id) : c.payee_name, Number(c.amount)));
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ cells: [k, r2(v)] as Cell[] }));
    return { head: ["Vendor", "Total"], align: ["l", "r"], rows: [...rows, { cells: ["Total", r2([...m.values()].reduce((s, v) => s + v, 0))], kind: "grand" }] };
  } },
  { id: "checks", group: "Expenses and vendors", name: "Check Detail", desc: "Every check written in the period.", dates: "range", run: async (p) => {
    const cs = await db.getAll<any>(`checks?select=*&check_date=gte.${p.from}&check_date=lte.${p.to}${hq(p)}&order=check_date.asc,check_number.asc.nullslast,id.asc`, 20000);
    const ok = cs.filter((c) => c.status !== "voided");
    return { head: ["Date", "No.", "Payee", "Memo", "Status", "Amount"], align: ["l", "l", "l", "l", "l", "r"],
      rows: [...cs.map((c) => ({ cells: [fmtDate(c.check_date), c.check_number ?? "—", c.payee_name, c.memo, c.status === "to_print" ? "To print" : c.status === "voided" ? "Void" : "Printed", c.status === "voided" ? 0 : Number(c.amount)] as Cell[] })),
        { cells: ["Total", null, null, null, null, r2(ok.reduce((s, c) => s + Number(c.amount), 0))], kind: "grand" }] };
  } },
  { id: "vend_list", group: "Expenses and vendors", name: "Vendor Contact List", desc: "Vendors with contact details and how they're paid.", dates: "asof", run: async (_p, lk) => ({
    head: ["Vendor", "Contact", "Email", "Phone", "Pays by", "Terms", "1099"], align: ["l", "l", "l", "l", "l", "l", "l"],
    rows: lk.vendors.filter((v) => v.status === "active").map((v) => ({ cells: [v.name, v.contact_name, v.email, v.phone, v.remit_method.toUpperCase(), v.payment_terms, v.is_1099 ? "Yes" : ""] })),
  }) },
  // ---- banking
  { id: "deposits", group: "Banking", name: "Deposit Detail", desc: "Money that came into the bank, and what it matched.", dates: "range", run: async (p, lk) => {
    const tx = await db.getAll<any>(`bank_transactions?select=posted_date,description,amount,status,matched_kind,gl_account_id,bank_account_id&amount=gt.0&status=neq.excluded&posted_date=gte.${p.from}&posted_date=lte.${p.to}${hq(p)}&order=posted_date.asc,id.asc`, 20000);
    const K: Record<string, string> = { deposit: "Night-audit deposit", deposit_batch: "Card batch", deposit_amex: "Amex", gl: "Categorised" };
    return { head: ["Date", "Description", "Matched / category", "Status", "Amount"], align: ["l", "l", "l", "l", "r"],
      rows: [...tx.map((t) => ({ cells: [fmtDate(t.posted_date), t.description, t.matched_kind === "gl" ? glLabel(acctOf(lk, t.gl_account_id)) : K[t.matched_kind] || "—", t.status === "posted" ? "Posted" : "For review", Number(t.amount)] as Cell[] })),
        { cells: ["Total", null, null, null, r2(tx.reduce((s, t) => s + Number(t.amount), 0))], kind: "grand" }] };
  } },
  { id: "bank_tx", group: "Banking", name: "Bank Transactions", desc: "Everything from the bank in the period, with its status.", dates: "range", run: async (p, lk) => {
    const tx = await db.getAll<any>(`bank_transactions?select=posted_date,description,ref,amount,status,matched_kind,gl_account_id,vendor_id&posted_date=gte.${p.from}&posted_date=lte.${p.to}${hq(p)}&order=posted_date.asc,id.asc`, 30000);
    return { head: ["Date", "Description", "Payee", "Category", "Status", "Amount"], align: ["l", "l", "l", "l", "l", "r"],
      rows: tx.map((t) => ({ cells: [fmtDate(t.posted_date), t.description + (t.ref ? ` #${t.ref}` : ""), t.vendor_id ? vName(lk, t.vendor_id) : "", t.gl_account_id ? glLabel(acctOf(lk, t.gl_account_id)) : t.matched_kind || "", t.status === "unmatched" || t.status === "matched" ? "For review" : t.status, Number(t.amount)] as Cell[] })) };
  } },
  { id: "uncat", group: "Banking", name: "Uncategorized and Excluded", desc: "Bank lines still waiting for a decision, and what was excluded.", dates: "range", run: async (p) => {
    const tx = await db.getAll<any>(`bank_transactions?select=posted_date,description,amount,status,matched_kind,gl_account_id&status=in.(unmatched,excluded)&posted_date=gte.${p.from}&posted_date=lte.${p.to}${hq(p)}&order=status.asc,posted_date.asc,id.asc`, 20000);
    const a = tx.filter((t) => t.status === "unmatched" && !t.gl_account_id), b = tx.filter((t) => t.status === "excluded");
    const sec = (title: string, xs: any[]): Row[] => [{ cells: [title, null, null], kind: "section" }, ...xs.map((t) => ({ cells: [fmtDate(t.posted_date), t.description, Number(t.amount)] as Cell[], indent: 1 })),
      { cells: [`Total ${title.toLowerCase()}`, null, r2(xs.reduce((s, t) => s + Number(t.amount), 0))], kind: "total" }];
    return { head: ["Date", "Description", "Amount"], align: ["l", "l", "r"], rows: [...sec("Uncategorized", a), ...sec("Excluded", b)] };
  } },
  { id: "recon", group: "Banking", name: "Reconciliation Summary", desc: "Each bank account: bank balance against the books, and what's still open.", dates: "asof", run: async (p, lk, ctx) => {
    const [acs, b, open, ck] = await Promise.all([
      db.get<BankAcct>(`bank_accounts?select=*${hq(p)}&order=name.asc`),
      balances(p, "1900-01-01"),
      db.getAll<any>(`bank_transactions?select=bank_account_id,amount&status=in.(unmatched,matched)&posted_date=lte.${p.to}${hq(p)}&order=id.asc`, 30000),
      db.getAll<any>(`checks?select=bank_account_id,amount,id&status=eq.printed&check_date=lte.${p.to}${hq(p)}&order=id.asc`, 20000),
    ]);
    const cleared = await db.getAll<any>(`bank_transactions?select=matched_ids&matched_kind=eq.check${hq(p)}&order=id.asc`, 20000);
    const clearedIds = new Set(cleared.flatMap((x) => x.matched_ids || []));
    return { head: ["Bank account", "Hotel", "Bank balance", "In books", "Difference", "Bank lines for review", "Checks not cleared"], align: ["l", "l", "r", "r", "r", "r", "r"],
      rows: acs.map((a) => {
        const bk = b.filter((x) => x.account_id === a.gl_account_id).reduce((s, x) => s + Number(x.opening) + Number(x.debit) - Number(x.credit), 0);
        const outCk = ck.filter((c) => c.bank_account_id === a.id && !clearedIds.has(c.id)).reduce((s, c) => s + Number(c.amount), 0);
        return { cells: [`${a.name} ••${a.last4 || ""}`, ctx.hotels.find((h) => h.id === a.hotel_id)?.name || "", a.balance == null ? null : Number(a.balance), r2(bk), a.balance == null ? null : r2(Number(a.balance) - bk),
          r2(open.filter((t) => t.bank_account_id === a.id).reduce((s, t) => s + Number(t.amount), 0)), r2(outCk)] as Cell[] };
      }), note: "Bank balance is the latest balance from the feed or statement. The difference should equal the bank lines still in review minus checks that haven't cleared." };
  } },
  // ---- for your accountant
  { id: "gl", group: "For your accountant", name: "General Ledger", desc: "Every posting by account, with running balances.", dates: "range", run: async (p, lk) => {
    const [ls, b] = await Promise.all([lines(p), balances(p, p.from)]);
    const byAcct = new Map<string, JLine[]>(); ls.forEach((l) => byAcct.set(l.account_id, [...(byAcct.get(l.account_id) || []), l]));
    const open = new Map<string, number>(); b.forEach((x) => open.set(x.account_id, (open.get(x.account_id) || 0) + Number(x.opening)));
    const ids = [...new Set([...byAcct.keys(), ...[...open.entries()].filter(([, v]) => Math.abs(v) >= 0.005).map(([k]) => k)])].map((id) => acctOf(lk, id)).filter(Boolean) as Gl[];
    ids.sort((a, c) => a.number.localeCompare(c.number));
    const out: Row[] = [];
    for (const g of ids) {
      let bal = open.get(g.id) || 0;
      const xs = (byAcct.get(g.id) || []).sort((a, c) => a.journal_entries.entry_date.localeCompare(c.journal_entries.entry_date));
      out.push({ cells: [glLabel(g), null, null, null, null, r2(bal * nat(g))], kind: "section" });
      xs.forEach((l) => { bal += Number(l.debit) - Number(l.credit); out.push({ cells: [fmtDate(l.journal_entries.entry_date), SOURCE[l.journal_entries.source] || l.journal_entries.source, l.memo || l.journal_entries.memo, Number(l.debit) || null, Number(l.credit) || null, r2(bal * nat(g))], indent: 1 }); });
      out.push({ cells: [`Total ${g.name}`, null, null, r2(xs.reduce((s, l) => s + Number(l.debit), 0)), r2(xs.reduce((s, l) => s + Number(l.credit), 0)), r2(bal * nat(g))], kind: "total" });
    }
    return { head: ["Date", "Type", "Memo", "Debit", "Credit", "Balance"], align: ["l", "l", "l", "r", "r", "r"], rows: out };
  } },
  { id: "journal", group: "For your accountant", name: "Journal", desc: "Every entry with its debit and credit lines.", dates: "range", run: async (p, lk) => {
    const ls = await lines(p);
    const by = new Map<string, JLine[]>(); ls.forEach((l) => by.set(l.entry_id, [...(by.get(l.entry_id) || []), l]));
    const es = [...by.values()].sort((a, c) => a[0].journal_entries.entry_date.localeCompare(c[0].journal_entries.entry_date));
    const out: Row[] = [];
    es.forEach((xs) => {
      const e = xs[0].journal_entries;
      out.push({ cells: [fmtDate(e.entry_date), SOURCE[e.source] || e.source, e.memo, null, null], kind: "sub" });
      xs.forEach((l) => out.push({ cells: [null, null, glLabel(acctOf(lk, l.account_id)), Number(l.debit) || null, Number(l.credit) || null], indent: 1 }));
    });
    return { head: ["Date", "Type", "Account / memo", "Debit", "Credit"], align: ["l", "l", "l", "r", "r"],
      rows: [...out, { cells: ["Total", null, null, r2(ls.reduce((s, l) => s + Number(l.debit), 0)), r2(ls.reduce((s, l) => s + Number(l.credit), 0))], kind: "grand" }] };
  } },
  { id: "txlist", group: "For your accountant", name: "Transaction List by Date", desc: "One line per entry, in date order.", dates: "range", run: async (p) => {
    const es = await db.getAll<any>(`journal_entries?select=entry_date,memo,source,id,journal_lines(debit)&entry_date=gte.${p.from}&entry_date=lte.${p.to}${hq(p)}&order=entry_date.asc,id.asc`, 30000);
    return { head: ["Date", "Type", "Memo", "Amount"], align: ["l", "l", "l", "r"],
      rows: es.map((e) => ({ cells: [fmtDate(e.entry_date), SOURCE[e.source] || e.source, e.memo, r2((e.journal_lines || []).reduce((s: number, l: any) => s + Number(l.debit), 0))] as Cell[] })) };
  } },
  { id: "quick", group: "For your accountant", name: "Account QuickReport", desc: "Every posting to one account.", dates: "range", account: true, run: async (p, lk) => {
    if (!p.account) return { head: ["Choose an account above"], rows: [] };
    const [ls, b] = await Promise.all([lines(p, `&account_id=eq.${p.account}`), balances(p, p.from)]);
    const g = acctOf(lk, p.account);
    let bal = b.filter((x) => x.account_id === p.account).reduce((s, x) => s + Number(x.opening), 0);
    const rows: Row[] = [{ cells: ["Beginning balance", null, null, null, null, r2(bal * nat(g))], kind: "sub" }];
    ls.sort((a, c) => a.journal_entries.entry_date.localeCompare(c.journal_entries.entry_date)).forEach((l) => {
      bal += Number(l.debit) - Number(l.credit);
      rows.push({ cells: [fmtDate(l.journal_entries.entry_date), SOURCE[l.journal_entries.source] || l.journal_entries.source, l.memo || l.journal_entries.memo, Number(l.debit) || null, Number(l.credit) || null, r2(bal * nat(g))] });
    });
    return { head: ["Date", "Type", "Memo", "Debit", "Credit", "Balance"], align: ["l", "l", "l", "r", "r", "r"], rows: [...rows, { cells: ["Ending balance", null, null, null, null, r2(bal * nat(g))], kind: "grand" }] };
  } },
];
const GROUPS = [...new Set(DEFS.map((d) => d.group))];

export function FinancialReports({ ctx }: { ctx: Ctx }) {
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.hash.split("?")[1] || "").get("r"));
  const [find, setFind] = useState("");
  const def = DEFS.find((d) => d.id === open);
  if (def) return <ReportView ctx={ctx} def={def} onBack={() => setOpen(null)} />;
  const shown = DEFS.filter((d) => !find.trim() || `${d.name} ${d.desc} ${d.group}`.toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <>
      <PageHead eyebrow="Finance" title="Financial Reports" desc={`${DEFS.length} standard reports from the books, bills, checks and the bank. Pick one to run it for any hotel and dates.`} />
      <div className="toolbar"><input type="search" aria-label="Find a report" placeholder="Find a report…" value={find} onChange={(e) => setFind(e.target.value)} style={{ minWidth: 280 }} /></div>
      <div className="grid g2">
        {GROUPS.map((g) => {
          const ds = shown.filter((d) => d.group === g);
          if (!ds.length) return null;
          return (
            <Card key={g} title={g} flush>
              <div className="list">{ds.map((d) => (
                <button key={d.id} type="button" className="li rep" onClick={() => setOpen(d.id)}>
                  <div><div className="t">{d.name}</div><div className="s">{d.desc}</div></div><span className="r" aria-hidden="true">›</span>
                </button>
              ))}</div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function ReportView({ ctx, def, onBack }: { ctx: Ctx; def: Def; onBack: () => void }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotel, setHotel] = useState("");
  const today = todayIn();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [account, setAccount] = useState("");
  const lk = useLookups(ctx);
  const params: Params = { hotels: hotel ? [hotel] : null, from: def.dates === "asof" ? "1900-01-01" : from, to, account: account || undefined };
  const q = useAsync(async () => (lk.data ? def.run(params, { gl: lk.data.gl, vendors: lk.data.vendors }, ctx) : null), [def.id, hotel, from, to, account, !!lk.data]);
  const fmt = (v: Cell, i: number, align?: ("l" | "r")[]) => (typeof v === "number" && (align?.[i] === "r") ? usd(v, 2) : v ?? "");
  const presets: [string, () => [string, string]][] = [
    ["This month", () => [`${today.slice(0, 7)}-01`, today]],
    ["Last month", () => { const e = addDays(`${today.slice(0, 7)}-01`, -1); return [`${e.slice(0, 7)}-01`, e]; }],
    ["This year", () => [`${today.slice(0, 4)}-01-01`, today]],
    ["Last year", () => { const y = Number(today.slice(0, 4)) - 1; return [`${y}-01-01`, `${y}-12-31`]; }],
  ];
  const accounts = useMemo(() => (lk.data?.gl || []).filter((g) => (hotel ? g.hotel_id === hotel : !!g.hotel_id)).sort((a, b) => a.number.localeCompare(b.number)), [lk.data, hotel]);
  function csv() {
    const o = q.data; if (!o) return;
    downloadFile(`${def.id}-${hotel ? ctx.hotels.find((h) => h.id === hotel)?.name : "all-hotels"}-${to}.csv`.replace(/\s+/g, "-"), "﻿" + toCsv([
      [def.name], [hotel ? ctx.hotels.find((h) => h.id === hotel)?.name || "" : `${ctx.tenant.brand_name || ctx.tenant.name} · all hotels`],
      [def.dates === "asof" ? `As of ${fmtDate(to)}` : `${fmtDate(from)} to ${fmtDate(to)}`], [], o.head,
      ...o.rows.map((r) => r.cells.map((c, i) => (i === 0 && r.indent ? "  ".repeat(r.indent) + (c ?? "") : typeof c === "number" ? c.toFixed(2) : c ?? ""))),
    ]));
  }
  return (
    <>
      <div className="ph no-print-head">
        <div><button className="link" onClick={onBack}>‹ All reports</button><h1>{def.name}</h1><p>{def.desc}</p></div>
        <div className="acts"><button className="btn" onClick={csv} disabled={!q.data}>Export</button><button className="btn" onClick={() => window.print()}>Print</button></div>
      </div>
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotel} onChange={setHotel} all />
        {def.dates === "range" && <>
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          <select aria-label="Period" value="" onChange={(e) => { const p = presets.find((x) => x[0] === e.target.value); if (p) { const [a, b] = p[1](); setFrom(a); setTo(b); } }}>
            <option value="">Quick dates…</option>{presets.map(([k]) => <option key={k} value={k}>{k}</option>)}
          </select>
        </>}
        {def.dates === "asof" && <><label className="small" htmlFor="rAsOf">As of</label><input id="rAsOf" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></>}
        {def.account && <select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)} style={{ minWidth: 260 }}><option value="">Choose account…</option>{accounts.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select>}
      </div>
      <Card flush>
        <div className="rep-head">
          <div className="rep-co">{hotel ? ctx.hotels.find((h) => h.id === hotel)?.name : `${ctx.tenant.brand_name || ctx.tenant.name} · all hotels`}</div>
          <div className="rep-name">{def.name}</div>
          <div className="small muted">{def.dates === "asof" ? `As of ${fmtDate(to)}` : `${fmtDate(from)} – ${fmtDate(to)}`}</div>
        </div>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : !q.data || !q.data.rows.length ? <Empty title="Nothing in this period." /> : (
          <div className="tw"><table className="report">
            <thead><tr>{q.data.head.map((h, i) => <th key={i} className={q.data!.align?.[i] === "r" ? "n" : ""}>{h}</th>)}</tr></thead>
            <tbody>{q.data.rows.map((r, k) => (
              <tr key={k} className={r.kind || ""}>{r.cells.map((c, i) => (
                <td key={i} className={q.data!.align?.[i] === "r" ? "n" : ""} style={i === 0 && r.indent ? { paddingLeft: 16 + r.indent * 18 } : undefined}>{fmt(c, i, q.data!.align)}</td>
              ))}</tr>
            ))}</tbody>
          </table></div>
        )}
        {q.data?.note && <p className="small muted" style={{ padding: "0 18px" }}>{q.data.note}</p>}
      </Card>
    </>
  );
}
