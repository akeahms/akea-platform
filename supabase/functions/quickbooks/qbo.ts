// QuickBooks Online: OAuth tokens, API calls, and the push of Akea activity into each hotel's QuickBooks company.
// Secrets (Supabase → Edge Functions → Secrets): QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV = sandbox | production.

const env = (k: string) => (globalThis as any).Deno?.env.get(k) || "";
export const qboOn = () => !!(env("QBO_CLIENT_ID") && env("QBO_CLIENT_SECRET"));
export const qboEnv = () => (env("QBO_ENV") === "production" ? "production" : "sandbox");
const API = () => (qboEnv() === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com");
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const basic = () => "Basic " + btoa(`${env("QBO_CLIENT_ID")}:${env("QBO_CLIENT_SECRET")}`);

export class QboError extends Error {
  constructor(message: string, public code = "", public relogin = false) { super(message); }
}

export type Conn = {
  hotel_id: string; tenant_id: string; realm_id: string; company_name: string | null; status: string;
  access_token: string | null; refresh_token: string | null; access_expires_at: string | null; refresh_expires_at: string | null;
};
export type Gl = { id: string; number: string; name: string; type: string; full_name?: string | null; system_key?: string | null };
export type Line = { gl_account_id: string; debit: number; credit: number; desc: string };

// ------------------------------------------------------------------ OAuth
export function authorizeUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({ client_id: env("QBO_CLIENT_ID"), response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirectUri, state });
  return `https://appcenter.intuit.com/connect/oauth2?${q}`;
}
async function tokenCall(form: Record<string, string>) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: basic(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new QboError(j.error_description || j.error || `QuickBooks sign-in failed (${r.status})`, j.error || `HTTP_${r.status}`, j.error === "invalid_grant");
  const now = Date.now();
  return {
    access_token: j.access_token as string, refresh_token: j.refresh_token as string,
    access_expires_at: new Date(now + (Number(j.expires_in) || 3600) * 1000).toISOString(),
    refresh_expires_at: new Date(now + (Number(j.x_refresh_token_expires_in) || 100 * 86400) * 1000).toISOString(),
  };
}
export const exchangeCode = (code: string, redirectUri: string) => tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
export async function revoke(refreshToken: string | null) {
  if (!refreshToken) return;
  await fetch(REVOKE_URL, { method: "POST", headers: { Authorization: basic(), Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ token: refreshToken }) }).catch(() => null);
}

/** A valid access token; refreshes (and saves the rotated refresh token) when it's about to expire. */
export async function accessToken(admin: any, c: Conn, force = false) {
  if (!force && c.access_token && c.access_expires_at && Date.parse(c.access_expires_at) - Date.now() > 120_000) return c.access_token;
  const used = c.refresh_token || "";
  try {
    const t = await tokenCall({ grant_type: "refresh_token", refresh_token: used });
    Object.assign(c, t);
    // save only if nobody else refreshed meanwhile (compare-and-swap on the token we used); retry the save once
    for (let i = 0; i < 2; i++) {
      const { error } = await admin.from("qbo_connections").update({ ...t, updated_at: new Date().toISOString() }).eq("hotel_id", c.hotel_id).eq("refresh_token", used);
      if (!error) break;
      if (i === 1) console.error("quickbooks: couldn't save the new token:", error.message);
    }
    return t.access_token;
  } catch (e) {
    const q = e as QboError;
    // another sync (nightly job or a click) may have rotated the token first: use the newer stored one
    if (q.relogin) {
      const { data: now } = await admin.from("qbo_connections").select("access_token,refresh_token,access_expires_at").eq("hotel_id", c.hotel_id).maybeSingle();
      if (now?.refresh_token && now.refresh_token !== used) { Object.assign(c, now); return accessToken(admin, c, false); }
    }
    if (q.relogin) await admin.from("qbo_connections").update({ status: "needs_relogin", last_error: "QuickBooks needs you to sign in again (the connection expired or was removed in QuickBooks).", updated_at: new Date().toISOString() }).eq("hotel_id", c.hotel_id);
    if (q.relogin) throw new QboError("QuickBooks needs you to sign in again.", q.code, true);
    throw e;
  }
}

export async function qbo(admin: any, c: Conn, method: "GET" | "POST", path: string, body?: unknown, requestId?: string, retried = false): Promise<any> {
  const token = await accessToken(admin, c, retried);
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API()}/v3/company/${c.realm_id}/${path}${sep}minorversion=75${requestId ? `&requestid=${requestId}` : ""}`;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && !retried) return qbo(admin, c, method, path, body, requestId, true);
  const j = await r.json().catch(() => ({}));
  const fault = j.Fault?.Error?.[0];
  if (!r.ok || fault) throw new QboError(fault ? `${fault.Message}${fault.Detail ? ": " + fault.Detail : ""}` : `QuickBooks error ${r.status}`, fault?.code || `HTTP_${r.status}`);
  return j;
}
export const query = (admin: any, c: Conn, sql: string) => qbo(admin, c, "GET", `query?query=${encodeURIComponent(sql)}`);

// ------------------------------------------------------------------ entries (pure; unit-tested)
const r2 = (n: number) => Math.round(n * 100) / 100;
const CARD = new Set(["visa", "mastercard", "discover", "amex", "ota", "jcb", "diners", "card"]);

/** Night-audit revenue as a balanced journal, by account role (each hotel's chart says which account plays each role,
 *  so renaming or renumbering accounts doesn't break the sync). The guest ledger absorbs the difference
 *  between what was charged and what was paid (guests in house, advance deposits). */
export const ROLE_LABEL: Record<string, string> = {
  room_revenue: "room revenue", fnb_revenue: "food & beverage revenue", other_revenue: "other revenue", sales_tax: "sales tax payable",
  card_clearing: "credit card clearing", cash: "operating cash", ar_direct_bill: "direct bill receivable", guest_ledger: "guest ledger", default_expense: "default expense",
};
export function dailyRevenueLines(dm: any, deposits: { source: string; amount: number }[]) {
  const out: { role: string; debit: number; credit: number; desc: string }[] = [];
  const cr = (role: string, v: unknown, desc: string) => { const a = r2(Number(v) || 0); if (a > 0) out.push({ role, debit: 0, credit: a, desc }); else if (a < 0) out.push({ role, debit: -a, credit: 0, desc }); };
  const dr = (role: string, v: number, desc: string) => { const a = r2(v); if (a > 0) out.push({ role, debit: a, credit: 0, desc }); else if (a < 0) out.push({ role, debit: 0, credit: -a, desc }); };
  cr("room_revenue", dm.room_revenue, "Room revenue");
  cr("fnb_revenue", dm.fnb_revenue, "Food & beverage revenue");
  cr("other_revenue", dm.other_revenue, "Other revenue");
  cr("sales_tax", dm.tax_total, "Sales & occupancy tax collected");
  const by = new Map<string, number>();
  for (const d of deposits) by.set(d.source, (by.get(d.source) || 0) + Number(d.amount || 0));
  for (const [src, amt] of [...by.entries()].sort()) {
    const label = src.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (CARD.has(src)) dr("card_clearing", amt, `${label} payments`);
    else if (src === "cash") dr("cash", amt, "Cash payments");
    else if (src === "direct_bill") dr("ar_direct_bill", amt, "Direct bill (city ledger)");
    else dr("card_clearing", amt, `${label} payments`);
  }
  const diff = r2(out.reduce((a, l) => a + l.credit - l.debit, 0));
  if (diff > 0) out.push({ role: "guest_ledger", debit: diff, credit: 0, desc: "Guest ledger (charged, not yet paid)" });
  else if (diff < 0) out.push({ role: "guest_ledger", debit: 0, credit: -diff, desc: "Guest ledger (payments ahead of charges)" });
  return out;
}

/** Map Akea account lines to a QuickBooks JournalEntry. Returns the Akea accounts still missing a mapping. */
export function journalPayload(lines: Line[], map: Map<string, string>, date: string, docNumber: string, note: string) {
  const missing = [...new Set(lines.filter((l) => !map.get(l.gl_account_id)).map((l) => l.gl_account_id))];
  if (missing.length) return { missing };
  const Line = lines.filter((l) => r2(l.debit) || r2(l.credit)).map((l) => ({
    DetailType: "JournalEntryLineDetail", Amount: r2(l.debit || l.credit), Description: l.desc.slice(0, 4000),
    JournalEntryLineDetail: { PostingType: l.debit ? "Debit" : "Credit", AccountRef: { value: map.get(l.gl_account_id)! } },
  }));
  const dr = r2(lines.reduce((a, l) => a + (l.debit || 0), 0)), cr = r2(lines.reduce((a, l) => a + (l.credit || 0), 0));
  if (dr !== cr) throw new QboError(`Entry doesn't balance (debits ${dr}, credits ${cr})`, "UNBALANCED");
  return { payload: { TxnDate: date, DocNumber: docNumber.slice(0, 21), PrivateNote: note.slice(0, 4000), Line } };
}

export function billPayload(bill: any, qboVendorId: string, qboAccountId: string) {
  return {
    VendorRef: { value: qboVendorId }, TxnDate: bill.invoice_date || String(bill.created_at).slice(0, 10), DueDate: bill.due_date || undefined,
    DocNumber: bill.invoice_no ? String(bill.invoice_no).slice(0, 21) : undefined, PrivateNote: "Sent from Akea",
    Line: [{ DetailType: "AccountBasedExpenseLineDetail", Amount: r2(Number(bill.amount)), Description: (bill.description || "").slice(0, 4000),
      AccountBasedExpenseLineDetail: { AccountRef: { value: qboAccountId } } }],
  };
}

export function billPaymentPayload(bill: any, qboVendorId: string, qboBillId: string, qboBankId: string) {
  return {
    VendorRef: { value: qboVendorId }, PayType: "Check", CheckPayment: { BankAccountRef: { value: qboBankId } },
    TotalAmt: r2(Number(bill.amount)), TxnDate: bill.paid_at, PrivateNote: `Paid in Akea${bill.payment_method ? ` by ${bill.payment_method}` : ""}${bill.payment_ref ? ` · ref ${bill.payment_ref}` : ""}`,
    Line: [{ Amount: r2(Number(bill.amount)), LinkedTxn: [{ TxnId: qboBillId, TxnType: "Bill" }] }],
  };
}

// ------------------------------------------------------------------ account matching (pure; unit-tested)
const TYPE_OK: Record<string, RegExp> = {
  revenue: /income/i, expense: /expense|cost of goods/i, asset: /bank|asset|receivable/i, liability: /payable|liability|credit card/i, equity: /equity/i,
};
const words = (s: string) => new Set(s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["and", "the", "for"].includes(w)));
export type QAcct = { qbo_id: string; name: string; full_name: string | null; acct_num: string | null; account_type: string | null };
/** Suggest a QuickBooks account for each Akea account: same number, then same full name (Parent:Child), then same name,
 *  then best word overlap of a compatible type. */
export function suggestMap(gls: Gl[], qas: QAcct[]) {
  const out = new Map<string, string>();
  for (const g of gls) {
    const ok = qas.filter((q) => !TYPE_OK[g.type] || TYPE_OK[g.type].test(q.account_type || ""));
    const fn = (g.full_name || "").trim().toLowerCase();
    let hit = ok.find((q) => q.acct_num && q.acct_num === g.number)
      || (fn ? ok.find((q) => (q.full_name || "").trim().toLowerCase() === fn) : undefined)
      || ok.find((q) => q.name.trim().toLowerCase() === g.name.trim().toLowerCase());
    if (!hit) {
      const gw = words(g.name); let best = 0;
      for (const q of ok) {
        const qw = words(q.full_name || q.name); const common = [...gw].filter((w) => qw.has(w)).length;
        const score = common / Math.max(gw.size, qw.size, 1);
        if (score > best && score >= 0.5) { best = score; hit = q; }
      }
    }
    if (hit) out.set(g.id, hit.qbo_id);
  }
  return out;
}

export async function hashId(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ------------------------------------------------------------------ pulling the chart of accounts
export async function pullAccounts(admin: any, c: Conn) {
  const j = await query(admin, c, "select * from Account where Active = true maxresults 1000");
  const rows = (j.QueryResponse?.Account || []).map((a: any) => ({
    hotel_id: c.hotel_id, tenant_id: c.tenant_id, qbo_id: String(a.Id), name: a.Name, full_name: a.FullyQualifiedName || a.Name,
    acct_num: a.AcctNum || null, account_type: a.AccountType || null, account_subtype: a.AccountSubType || null, active: a.Active !== false,
  }));
  await admin.from("qbo_accounts").delete().eq("hotel_id", c.hotel_id);
  if (rows.length) { const { error } = await admin.from("qbo_accounts").insert(rows); if (error) throw new Error(error.message); }
  return rows.length;
}

async function ensureVendor(admin: any, c: Conn, vendor: { id: string; name: string }) {
  const { data: m } = await admin.from("qbo_vendor_map").select("qbo_vendor_id").eq("hotel_id", c.hotel_id).eq("vendor_id", vendor.id).maybeSingle();
  if (m) return m.qbo_vendor_id as string;
  const name = vendor.name.replace(/:/g, "-").slice(0, 100);
  const found = await query(admin, c, `select Id from Vendor where DisplayName = '${esc(name)}'`);
  let id = found.QueryResponse?.Vendor?.[0]?.Id;
  if (!id) id = (await qbo(admin, c, "POST", "vendor", { DisplayName: name, CompanyName: name }, await hashId(`vendor|${c.hotel_id}|${vendor.id}`))).Vendor.Id;
  await admin.from("qbo_vendor_map").upsert({ hotel_id: c.hotel_id, vendor_id: vendor.id, qbo_vendor_id: String(id) });
  return String(id);
}

// ------------------------------------------------------------------ the push
/** Every row of a query, 500 at a time (PostgREST caps a single read at 1000 rows). */
export async function allRows(make: (from: number, to: number) => any, cap = 20000): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < cap; from += 500) {
    const { data, error } = await make(from, from + 499);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return out;
}
const MAX_ATTEMPTS = 8;   // an item that has failed this often stops being retried automatically (it stays in the log)
export type SyncCounts = { synced: number; failed: number; needs_mapping: number };

export async function syncHotel(admin: any, c: Conn, opts: { yesterday: string; limit?: number }): Promise<SyncCounts> {
  const counts: SyncCounts = { synced: 0, failed: 0, needs_mapping: 0 };
  const limit = opts.limit ?? 150;
  const [{ data: s }, gls, maps, logs] = await Promise.all([
    admin.from("qbo_settings").select("*").eq("hotel_id", c.hotel_id).maybeSingle(),
    allRows((f, t) => admin.from("gl_accounts").select("id,number,name,type,full_name,system_key").eq("hotel_id", c.hotel_id).order("id").range(f, t)),   // this hotel's own chart
    allRows((f, t) => admin.from("qbo_account_map").select("gl_account_id,qbo_account_id").eq("hotel_id", c.hotel_id).order("gl_account_id").range(f, t)),
    allRows((f, t) => admin.from("qbo_sync_log").select("object_type,object_key,status,qbo_id,attempts").eq("hotel_id", c.hotel_id).order("object_type").order("object_key").range(f, t), 200000),
  ]);
  const settings = s || { start_date: opts.yesterday, push_daily_revenue: true, push_bills: true, push_payments: true, push_journals: true };
  const start = settings.start_date;
  const glByRole = new Map<string, Gl>((gls || []).filter((g: Gl) => g.system_key).map((g: Gl) => [g.system_key!, g]));
  const glById = new Map<string, Gl>((gls || []).map((g: Gl) => [g.id, g]));
  const map = new Map<string, string>((maps || []).map((m: any) => [m.gl_account_id, m.qbo_account_id]));
  const log = new Map<string, any>((logs || []).map((l: any) => [`${l.object_type}|${l.object_key}`, l]));
  // already sent, or given up on after repeated failures (still visible in the sync log)
  const done = (t: string, k: string) => { const l = log.get(`${t}|${k}`); return l?.status === "synced" || (l?.status === "failed" && (l.attempts || 0) >= MAX_ATTEMPTS); };
  let budget = limit;

  async function record(t: string, k: string, label: string, amount: number | null, status: "synced" | "failed" | "needs_mapping", qboId: string | null, error: string | null) {
    const prev = log.get(`${t}|${k}`);
    const row = { tenant_id: c.tenant_id, hotel_id: c.hotel_id, object_type: t, object_key: k, label, amount, status, qbo_id: qboId, error, attempts: (prev?.attempts || 0) + 1, updated_at: new Date().toISOString() };
    await admin.from("qbo_sync_log").upsert(row, { onConflict: "hotel_id,object_type,object_key" });
    log.set(`${t}|${k}`, row);
    counts[status === "synced" ? "synced" : status === "failed" ? "failed" : "needs_mapping"]++;
  }
  const missingNames = (ids: string[]) => ids.map((id) => { const g = glById.get(id); return g ? `${g.number} ${g.full_name || g.name}` : `the ${ROLE_LABEL[id] || id} account`; }).join(", ");
  async function push(t: string, k: string, label: string, amount: number, fn: () => Promise<{ missing?: string[]; qboId?: string }>) {
    if (budget-- <= 0) return;
    try {
      const r = await fn();
      if (r.missing?.length) await record(t, k, label, amount, "needs_mapping", null, `Map these accounts to QuickBooks: ${missingNames(r.missing)}`);
      else await record(t, k, label, amount, "synced", r.qboId || null, null);
    } catch (e) {
      const q = e as QboError;
      if (q.relogin) throw e;
      await record(t, k, label, amount, "failed", null, String(q.message).slice(0, 500));
    }
  }

  // 1) daily revenue from the night audit
  if (settings.push_daily_revenue) {
    const days = await allRows((f, t) => admin.from("daily_metrics").select("*").eq("hotel_id", c.hotel_id).neq("data_source", "sample")
      .gte("business_date", start).lte("business_date", opts.yesterday).order("business_date").range(f, t));
    for (const dm of days) {
      if (done("daily_revenue", dm.business_date)) continue;
      const { data: deps } = await admin.from("expected_deposits").select("source,amount,status").eq("hotel_id", c.hotel_id).eq("business_date", dm.business_date).neq("data_source", "sample");
      const raw = dailyRevenueLines(dm, (deps || []).filter((d: any) => d.status !== "written_off"));
      if (!raw.length) continue;
      const total = r2(raw.reduce((a, l) => a + l.credit, 0));
      await push("daily_revenue", dm.business_date, `Night audit ${dm.business_date}`, total, async () => {
        const absent = [...new Set(raw.filter((l) => !glByRole.get(l.role)).map((l) => ROLE_LABEL[l.role] || l.role))];
        if (absent.length) throw new QboError(`This hotel's chart of accounts has no ${absent.join(", ")} account. Add the template accounts in Accounting → Chart of accounts.`);
        const lines: Line[] = raw.map((l) => ({ gl_account_id: glByRole.get(l.role)!.id, debit: l.debit, credit: l.credit, desc: l.desc }));
        const p = journalPayload(lines, map, dm.business_date, `NA-${dm.business_date.replace(/-/g, "")}`, `Night audit revenue for ${dm.business_date}, sent from Akea`);
        if (p.missing) return { missing: p.missing };
        const j = await qbo(admin, c, "POST", "journalentry", p.payload, await hashId(`rev|${c.hotel_id}|${dm.business_date}|${JSON.stringify(p.payload)}`));
        return { qboId: String(j.JournalEntry.Id) };
      });
    }
  }

  // 2) approved bills (vendor created in QuickBooks when needed)
  const bills = settings.push_bills || settings.push_payments
    ? await allRows((f, t) => admin.from("bills").select("*, vendors(id,name)").eq("hotel_id", c.hotel_id).neq("data_source", "sample")
        .in("status", ["approved", "scheduled", "paid"]).order("created_at").order("id").range(f, t))
    : [];
  const eligible = (bills || []).filter((b: any) => (b.invoice_date || String(b.created_at).slice(0, 10)) >= start);
  if (settings.push_bills) {
    for (const b of eligible) {
      if (done("bill", b.id)) continue;
      await push("bill", b.id, `${b.vendors?.name || "Bill"}${b.invoice_no ? " #" + b.invoice_no : ""}`, Number(b.amount), async () => {
        if (!b.vendors) throw new QboError("This bill has no vendor. Add one in Akea, then sync again.");
        const glId = b.gl_account_id || glByRole.get("default_expense")?.id;
        if (!glId || !map.get(glId)) return { missing: [glId || "default_expense"] };
        const vid = await ensureVendor(admin, c, b.vendors);
        const p = billPayload(b, vid, map.get(glId)!);
        const j = await qbo(admin, c, "POST", "bill", p, await hashId(`bill|${c.hotel_id}|${b.id}|${JSON.stringify(p)}`));
        return { qboId: String(j.Bill.Id) };
      });
    }
  }

  // 3) payments of bills that are already in QuickBooks
  if (settings.push_payments) {
    const bankGl = new Map<string, string | null>();
    for (const b of eligible.filter((x: any) => x.status === "paid" && x.paid_at && x.paid_at >= start)) {
      if (done("bill_payment", b.id)) continue;
      const billLog = log.get(`bill|${b.id}`);
      if (billLog?.status !== "synced" || !billLog.qbo_id) continue;          // the bill goes first
      await push("bill_payment", b.id, `Payment · ${b.vendors?.name || "Bill"}${b.invoice_no ? " #" + b.invoice_no : ""}`, Number(b.amount), async () => {
        if (b.bank_account_id && !bankGl.has(b.bank_account_id)) {
          const { data: ba } = await admin.from("bank_accounts").select("gl_account_id").eq("id", b.bank_account_id).maybeSingle();
          bankGl.set(b.bank_account_id, ba?.gl_account_id || null);
        }
        const glId = (b.bank_account_id && bankGl.get(b.bank_account_id)) || glByRole.get("cash")?.id;
        if (!glId || !map.get(glId)) return { missing: [glId || "cash"] };
        const vid = await ensureVendor(admin, c, b.vendors);
        const p = billPaymentPayload(b, vid, billLog.qbo_id, map.get(glId)!);
        const j = await qbo(admin, c, "POST", "billpayment", p, await hashId(`pay|${c.hotel_id}|${b.id}|${JSON.stringify(p)}`));
        return { qboId: String(j.BillPayment.Id) };
      });
    }
  }

  // 4) journal entries made by hand in Akea (bill and payment postings are already covered above)
  if (settings.push_journals) {
    const jes = await allRows((f, t) => admin.from("journal_entries").select("id,entry_date,memo,journal_lines(account_id,debit,credit,memo)")
      .eq("hotel_id", c.hotel_id).eq("source", "manual").neq("data_source", "sample").gte("entry_date", start).order("entry_date").order("id").range(f, t));
    for (const je of jes) {
      if (done("journal", je.id)) continue;
      const lines: Line[] = (je.journal_lines || []).map((l: any) => ({ gl_account_id: l.account_id, debit: Number(l.debit), credit: Number(l.credit), desc: l.memo || je.memo || "" }));
      const total = r2(lines.reduce((a, l) => a + l.debit, 0));
      await push("journal", je.id, je.memo || `Journal ${je.entry_date}`, total, async () => {
        const p = journalPayload(lines, map, je.entry_date, `AK-${String(je.id).slice(0, 8)}`, je.memo || "Journal entry from Akea");
        if (p.missing) return { missing: p.missing };
        const j = await qbo(admin, c, "POST", "journalentry", p.payload, await hashId(`je|${c.hotel_id}|${je.id}|${JSON.stringify(p.payload)}`));
        return { qboId: String(j.JournalEntry.Id) };
      });
    }
  }
  return counts;
}
