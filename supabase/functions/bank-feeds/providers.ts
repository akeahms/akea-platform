// Plaid and Finicity (Mastercard Open Banking) clients, plus the sync that pulls a connected account's
// transactions and balance into the portal. Used by the portal actions, the bank webhooks and the nightly job.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   Plaid:    PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = sandbox | production
//   Finicity: FINICITY_PARTNER_ID, FINICITY_SECRET, FINICITY_APP_KEY, FINICITY_ENV = test | production

const env = (k: string) => (globalThis as any).Deno?.env.get(k) || "";

export const plaidOn = () => !!(env("PLAID_CLIENT_ID") && env("PLAID_SECRET"));
export const finicityOn = () => !!(env("FINICITY_PARTNER_ID") && env("FINICITY_SECRET") && env("FINICITY_APP_KEY"));
export const plaidEnv = () => (env("PLAID_ENV") === "production" ? "production" : "sandbox");
export const finicityEnv = () => (env("FINICITY_ENV") === "production" ? "production" : "test");

export type Row = { date: string; amount: number; description: string | null; ref: string | null; kind: string | null; external_id: string };
export type Conn = {
  bank_account_id: string; tenant_id: string; provider: "plaid" | "finicity"; status: string;
  item_id: string | null; access_token: string | null; external_account_id: string | null; customer_id: string | null;
  cursor: string | null; institution: string | null; last_synced_at: string | null;
};

// ---------------------------------------------------------------- Plaid
export class ProviderError extends Error {
  constructor(message: string, public code: string, public relogin = false) { super(message); }
}
const PLAID_RELOGIN = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "ITEM_LOCKED", "USER_PERMISSION_REVOKED", "ACCESS_NOT_GRANTED", "INVALID_CREDENTIALS", "INSUFFICIENT_CREDENTIALS", "NO_ACCOUNTS"]);

export async function plaid(path: string, body: Record<string, unknown>) {
  const r = await fetch(`https://${plaidEnv()}.plaid.com${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("PLAID_CLIENT_ID"), secret: env("PLAID_SECRET"), ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = j.error_code || `HTTP_${r.status}`;
    throw new ProviderError(j.display_message || j.error_message || `Plaid error ${r.status}`, code, PLAID_RELOGIN.has(code));
  }
  return j;
}

/** Plaid amounts are positive for money leaving the account; the portal uses positive for money coming in. */
export function normPlaid(t: any): Row | null {
  if (!t || t.pending) return null;
  return {
    date: t.date || t.authorized_date,
    amount: Math.round(-Number(t.amount) * 100) / 100,
    description: t.merchant_name || t.name || t.original_description || null,
    ref: t.check_number || null,
    kind: t.payment_channel || null,
    external_id: `plaid-${t.transaction_id}`,
  };
}

export async function plaidLinkToken(userId: string, webhook: string, accessToken?: string | null, clientName = "Hotel operations") {
  const body: Record<string, unknown> = {
    client_name: clientName.slice(0, 30), user: { client_user_id: userId }, country_codes: ["US"], language: "en", webhook,
  };
  if (accessToken) body.access_token = accessToken;            // update mode: re-enter the bank login
  else {
    body.products = ["transactions"];
    body.transactions = { days_requested: 730 };
    body.account_filters = { depository: { account_subtypes: ["checking", "savings", "money market"] } };
  }
  return (await plaid("/link/token/create", body)).link_token as string;
}

// ---------------------------------------------------------------- Finicity
const FIN = "https://api.finicity.com";
let finToken: { token: string; at: number } | null = null;
const FIN_RELOGIN = new Set(["103", "106", "108", "109", "169", "185", "187", "945"]);

async function finicityToken(force = false) {
  if (!force && finToken && Date.now() - finToken.at < 80 * 60 * 1000) return finToken.token;   // tokens last 2 hours
  const r = await fetch(`${FIN}/aggregation/v2/partners/authentication`, {
    method: "POST", headers: { "Finicity-App-Key": env("FINICITY_APP_KEY"), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ partnerId: env("FINICITY_PARTNER_ID"), partnerSecret: env("FINICITY_SECRET") }),
  });
  if (!r.ok) throw new ProviderError(`Finicity sign-in failed (${r.status}). Check the Finicity keys.`, `HTTP_${r.status}`);
  finToken = { token: (await r.json()).token, at: Date.now() };
  return finToken.token;
}

export async function finicity(path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const token = await finicityToken();
  const r = await fetch(FIN + path, { ...init, headers: { "Finicity-App-Key": env("FINICITY_APP_KEY"), "Finicity-App-Token": token, "Content-Type": "application/json", Accept: "application/json", ...(init.headers || {}) } });
  if (r.status === 401 && !retried) { await finicityToken(true); return finicity(path, init, true); }
  const text = await r.text();
  const j = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
  if (!r.ok) {
    const code = String(j.code ?? `HTTP_${r.status}`);
    throw new ProviderError(j.message || `Finicity error ${r.status}`, code, FIN_RELOGIN.has(code));
  }
  return j;
}

/** Finicity amounts already use positive for deposits. Dates are Unix seconds. */
export function normFinicity(x: any): Row | null {
  if (!x || (x.status && x.status !== "active")) return null;
  const secs = Number(x.postedDate || x.transactionDate);
  if (!secs) return null;
  return {
    date: new Date(secs * 1000).toISOString().slice(0, 10),
    amount: Math.round(Number(x.amount) * 100) / 100,
    description: x.description || x.memo || x.categorization?.normalizedPayeeName || null,
    ref: x.checkNum ? String(x.checkNum) : null,
    kind: x.type || null,
    external_id: `fin-${x.id}`,
  };
}

export async function finicityCustomer(username: string, label: string) {
  const path = finicityEnv() === "production" ? "/aggregation/v2/customers/active" : "/aggregation/v2/customers/testing";
  const c = await finicity(path, { method: "POST", body: JSON.stringify({ username, firstName: "Hotel", lastName: label.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 30) || "Account" }) });
  return String(c.id);
}

export async function finicityConnectUrl(customerId: string, webhook: string, institutionLoginId?: string | null) {
  const body: Record<string, unknown> = { partnerId: env("FINICITY_PARTNER_ID"), customerId, webhook, webhookContentType: "application/json", singleUseUrl: true };
  const path = institutionLoginId ? "/connect/v2/generate/fix" : "/connect/v2/generate";
  if (institutionLoginId) body.institutionLoginId = institutionLoginId;
  return (await finicity(path, { method: "POST", body: JSON.stringify(body) })).link as string;
}

// ---------------------------------------------------------------- accounts at the bank
export type ExtAccount = { id: string; name: string; mask: string | null; type: string | null; balance: number | null; login_id?: string | null; institution?: string | null };

export async function listAccounts(c: Conn): Promise<ExtAccount[]> {
  if (c.provider === "plaid") {
    const j = await plaid("/accounts/get", { access_token: c.access_token });
    return (j.accounts || []).map((a: any) => ({ id: a.account_id, name: a.official_name || a.name, mask: a.mask || null, type: a.subtype || a.type, balance: a.balances?.current ?? null }));
  }
  const j = await finicity(`/aggregation/v1/customers/${c.customer_id}/accounts`);
  return (j.accounts || []).map((a: any) => ({ id: String(a.id), name: a.name, mask: (a.accountNumberDisplay || a.number || "").replace(/\D/g, "").slice(-4) || null,
    type: a.type || null, balance: a.balance ?? null, login_id: a.institutionLoginId ? String(a.institutionLoginId) : null, institution: a.institutionId ? String(a.institutionId) : null }));
}

/** Prefer an account whose last 4 digits match the portal's record, then checking, then the first one. */
export function pickAccount(accts: ExtAccount[], last4?: string | null): ExtAccount | null {
  return accts.find((a) => last4 && a.mask === last4) || accts.find((a) => /checking/i.test(a.type || "")) || accts[0] || null;
}

// ---------------------------------------------------------------- sync
export type SyncResult = { added: number; duplicates: number; updated: number; removed: number; balance: number | null; matched: number };

export async function syncConnection(admin: any, c: Conn, opts: { refresh?: boolean } = {}): Promise<SyncResult> {
  const { data: acct } = await admin.from("bank_accounts").select("id,last4,institution").eq("id", c.bank_account_id).single();
  try {
    let rows: Row[] = [], modified: Row[] = [], removed: string[] = [], cursor = c.cursor, balance: number | null = null;
    let picked: ExtAccount | null = null;

    if (c.provider === "plaid") {
      if (!c.external_account_id) {
        picked = pickAccount(await listAccounts(c), acct?.last4);
        if (!picked) throw new ProviderError("The bank didn't share any accounts. Reconnect and tick the account to use.", "NO_ACCOUNTS", true);
        c.external_account_id = picked.id;
      }
      // transactions/sync pages; if the data changes mid-way Plaid asks us to restart from the starting cursor
      for (let attempt = 0; attempt < 3; attempt++) {
        rows = []; modified = []; removed = []; cursor = c.cursor;
        try {
          let more = true, pages = 0;
          while (more && pages++ < 50) {
            const j = await plaid("/transactions/sync", { access_token: c.access_token, cursor: cursor || undefined, count: 500 });
            for (const t of j.added || []) if (t.account_id === c.external_account_id) { const n = normPlaid(t); if (n) rows.push(n); }
            for (const t of j.modified || []) if (t.account_id === c.external_account_id) { const n = normPlaid(t); if (n) modified.push(n); }
            for (const t of j.removed || []) if (!t.account_id || t.account_id === c.external_account_id) removed.push(`plaid-${t.transaction_id}`);
            cursor = j.next_cursor; more = j.has_more;
          }
          break;
        } catch (e) {
          if ((e as ProviderError).code !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" || attempt === 2) throw e;
        }
      }
      const a = (await listAccounts(c)).find((x) => x.id === c.external_account_id);
      balance = a?.balance ?? null; picked = picked || a || null;
    } else {
      if (opts.refresh) await finicity(`/aggregation/v1/customers/${c.customer_id}/accounts`, { method: "POST", body: "{}" }).catch(() => null); // ask the bank for fresh data
      const accts = await listAccounts(c);
      if (!c.external_account_id) {
        picked = pickAccount(accts, acct?.last4);
        if (!picked) throw new ProviderError("No accounts yet. Finish signing in to the bank in the Finicity window, then sync again.", "NO_ACCOUNTS");
        c.external_account_id = picked.id;
      } else picked = accts.find((x) => x.id === c.external_account_id) || null;
      balance = picked?.balance ?? null;
      const since = c.last_synced_at ? Date.parse(c.last_synced_at) - 10 * 864e5 : Date.now() - 180 * 864e5;   // overlap catches late postings
      const from = Math.floor(since / 1000), to = Math.floor(Date.now() / 1000);
      for (let start = 1, guard = 0; guard < 20; guard++) {
        const j = await finicity(`/aggregation/v3/customers/${c.customer_id}/accounts/${c.external_account_id}/transactions?fromDate=${from}&toDate=${to}&start=${start}&limit=1000&sort=asc`);
        for (const x of j.transactions || []) { const n = normFinicity(x); if (n) rows.push(n); }
        const got = (j.transactions || []).length;
        if (got < 1000 || start + got > Number(j.found || 0)) break;
        start += got;
      }
    }

    // new transactions → same import path as statement uploads (dedupe + automatic matching)
    let added = 0, duplicates = 0, matched = 0;
    if (rows.length) {
      const { data: res, error } = await admin.rpc("import_bank_transactions", {
        p_account: c.bank_account_id, p_rows: rows,
        p_meta: { file_name: `${c.provider === "plaid" ? "Plaid" : "Finicity"} feed`, format: c.provider === "plaid" ? "Plaid" : "Finicity", source: c.provider },
      });
      if (error) throw new Error(error.message);
      added = res.added; duplicates = res.duplicates;
      matched = (res.matched_deposits || 0) + (res.matched_batches || 0) + (res.matched_amex || 0) + (res.matched_bills || 0);
    }
    // corrections from the bank: only touch rows nobody has reconciled yet
    let updated = 0, gone = 0;
    for (const m of modified) {
      const { data } = await admin.from("bank_transactions").update({ posted_date: m.date, amount: m.amount, description: m.description, ref: m.ref })
        .eq("bank_account_id", c.bank_account_id).eq("external_id", m.external_id).eq("status", "unmatched").select("id");
      updated += (data || []).length;
    }
    if (removed.length) {
      const { data } = await admin.from("bank_transactions").delete().eq("bank_account_id", c.bank_account_id).in("external_id", removed).eq("status", "unmatched").select("id");
      gone = (data || []).length;
    }

    const now = new Date().toISOString();
    await admin.from("bank_connections").update({
      cursor: c.provider === "plaid" ? cursor : c.cursor, external_account_id: c.external_account_id, status: "active", last_error: null, last_synced_at: now, updated_at: now,
      ...(picked ? { account_name: picked.name, account_mask: picked.mask } : {}),
    }).eq("bank_account_id", c.bank_account_id);
    const acctUpdate: Record<string, unknown> = { last_synced_at: now, feed: c.provider };
    if (balance != null) { acctUpdate.balance = balance; acctUpdate.balance_as_of = now.slice(0, 10); }
    if (picked?.mask && !acct?.last4) acctUpdate.last4 = picked.mask;
    if (c.institution && !acct?.institution) acctUpdate.institution = c.institution;
    await admin.from("bank_accounts").update(acctUpdate).eq("id", c.bank_account_id);
    return { added, duplicates, updated, removed: gone, balance, matched };
  } catch (e) {
    const pe = e as ProviderError;
    await admin.from("bank_connections").update({
      status: pe.relogin ? "needs_relogin" : "error", last_error: String(pe.message).slice(0, 400), updated_at: new Date().toISOString(),
    }).eq("bank_account_id", c.bank_account_id);
    throw e;
  }
}

export async function disconnect(c: Conn) {
  if (c.provider === "plaid" && c.access_token) await plaid("/item/remove", { access_token: c.access_token }).catch(() => null);
  if (c.provider === "finicity" && c.customer_id) await finicity(`/aggregation/v1/customers/${c.customer_id}`, { method: "DELETE" }).catch(() => null);
}
