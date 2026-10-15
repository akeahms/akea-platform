// Bank feeds: Plaid and Finicity. Tokens stay server-side in public.bank_connections (no API access for users).
// Secrets (Supabase → Edge Functions → Secrets): PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production),
// FINICITY_PARTNER_ID, FINICITY_SECRET, FINICITY_APP_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";
const SB_URL = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");

const plaidOn = () => !!(env("PLAID_CLIENT_ID") && env("PLAID_SECRET"));
const finicityOn = () => !!(env("FINICITY_PARTNER_ID") && env("FINICITY_SECRET") && env("FINICITY_APP_KEY"));
const plaidBase = () => (env("PLAID_ENV") === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com");

async function plaid(path: string, body: Record<string, unknown>) {
  const r = await fetch(plaidBase() + path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("PLAID_CLIENT_ID"), secret: env("PLAID_SECRET"), ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_message || j.display_message || `Plaid error ${r.status}`);
  return j;
}
async function finicityToken() {
  const r = await fetch("https://api.finicity.com/aggregation/v2/partners/authentication", {
    method: "POST", headers: { "Finicity-App-Key": env("FINICITY_APP_KEY"), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ partnerId: env("FINICITY_PARTNER_ID"), partnerSecret: env("FINICITY_SECRET") }) });
  if (!r.ok) throw new Error(`Finicity sign-in failed (${r.status})`);
  return (await r.json()).token as string;
}
async function finicity(path: string, init: RequestInit = {}) {
  const token = await finicityToken();
  const r = await fetch("https://api.finicity.com" + path, { ...init, headers: { "Finicity-App-Key": env("FINICITY_APP_KEY"), "Finicity-App-Token": token, "Content-Type": "application/json", Accept: "application/json", ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Finicity error ${r.status}`);
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    if (action === "status") {
      const on = { plaid: plaidOn(), finicity: finicityOn() };
      return json({ configured: on, message: on.plaid || on.finicity
        ? `Bank feeds are on (${[on.plaid && "Plaid", on.finicity && "Finicity"].filter(Boolean).join(" and ")}). Choose an account and connect it.`
        : "Bank feeds aren't switched on yet. Add your Plaid and/or Finicity keys in Supabase → Edge Functions → Secrets, then connect each bank here. Until then, upload statements in any format." });
    }

    // every other action works on one of the caller's bank accounts; RLS decides whether they can see it
    const { data: acct } = await user.from("bank_accounts").select("id,tenant_id,hotel_id,name").eq("id", body.bank_account_id).maybeSingle();
    if (!acct) return json({ error: "Bank account not found." }, 404);
    const { data: lvl } = await user.rpc("perm_level", { t: acct.tenant_id, mod: "finance" });
    if ((lvl ?? 0) < 3) return json({ error: "Connecting bank feeds needs finance approval rights." }, 403);

    if (action === "plaid_link_token") {
      if (!plaidOn()) return json({ error: "Plaid isn't configured." }, 400);
      const j = await plaid("/link/token/create", { client_name: "Hotel Portal", user: { client_user_id: u.user.id }, products: ["transactions"], country_codes: ["US"], language: "en",
        transactions: { days_requested: 730 } });
      return json({ link_token: j.link_token });
    }
    if (action === "plaid_exchange") {
      const ex = await plaid("/item/public_token/exchange", { public_token: body.public_token });
      const accts = await plaid("/accounts/get", { access_token: ex.access_token });
      const pick = body.plaid_account_id || accts.accounts.find((a: any) => a.subtype === "checking")?.account_id || accts.accounts[0]?.account_id;
      await admin.from("bank_connections").upsert({ bank_account_id: acct.id, tenant_id: acct.tenant_id, provider: "plaid", item_id: ex.item_id, access_token: ex.access_token,
        external_account_id: pick, institution: body.institution || null, created_by: u.user.id, updated_at: new Date().toISOString() });
      await admin.from("bank_accounts").update({ feed: "plaid" }).eq("id", acct.id);
      return json({ ok: true, accounts: accts.accounts.map((a: any) => ({ id: a.account_id, name: a.name, mask: a.mask, subtype: a.subtype })), linked: pick });
    }
    if (action === "finicity_connect_url") {
      if (!finicityOn()) return json({ error: "Finicity isn't configured." }, 400);
      const { data: existing } = await admin.from("bank_connections").select("customer_id").eq("bank_account_id", acct.id).maybeSingle();
      let customerId = existing?.customer_id;
      if (!customerId) {
        const c = await finicity("/aggregation/v2/customers/active", { method: "POST", body: JSON.stringify({ username: `acct-${acct.id}`, firstName: "Hotel", lastName: acct.name.slice(0, 30) }) });
        customerId = c.id;
        await admin.from("bank_connections").upsert({ bank_account_id: acct.id, tenant_id: acct.tenant_id, provider: "finicity", customer_id: customerId, created_by: u.user.id });
      }
      const link = await finicity("/connect/v2/generate", { method: "POST", body: JSON.stringify({ partnerId: env("FINICITY_PARTNER_ID"), customerId }) });
      return json({ url: link.link });
    }
    if (action === "sync") {
      const { data: c } = await admin.from("bank_connections").select("*").eq("bank_account_id", acct.id).maybeSingle();
      if (!c) return json({ error: "This account isn't connected to a bank feed yet." }, 400);
      const rows: any[] = [];
      if (c.provider === "plaid") {
        let cursor = c.cursor || undefined, more = true, guard = 0;
        while (more && guard++ < 20) {
          const j = await plaid("/transactions/sync", { access_token: c.access_token, cursor, count: 500 });
          for (const t of j.added as any[]) {
            if (c.external_account_id && t.account_id !== c.external_account_id) continue;
            if (t.pending) continue;
            // Plaid: positive = money out; ours: positive = money in
            rows.push({ date: t.date, amount: -Number(t.amount), description: t.merchant_name || t.name, ref: t.check_number || null, kind: t.payment_channel, external_id: `plaid-${t.transaction_id}` });
          }
          cursor = j.next_cursor; more = j.has_more;
        }
        await admin.from("bank_connections").update({ cursor, updated_at: new Date().toISOString() }).eq("bank_account_id", acct.id);
      } else {
        if (!c.external_account_id) {
          const a = await finicity(`/aggregation/v1/customers/${c.customer_id}/accounts`);
          const pick = (a.accounts || []).find((x: any) => /checking/i.test(x.type)) || (a.accounts || [])[0];
          if (!pick) return json({ error: "No accounts found yet. Finish connecting the bank in the Finicity window, then sync again." }, 400);
          c.external_account_id = String(pick.id);
          await admin.from("bank_connections").update({ external_account_id: c.external_account_id }).eq("bank_account_id", acct.id);
          await admin.from("bank_accounts").update({ feed: "finicity" }).eq("id", acct.id);
        }
        const from = Math.floor(Date.now() / 1000) - 90 * 86400, to = Math.floor(Date.now() / 1000);
        const t = await finicity(`/aggregation/v3/customers/${c.customer_id}/accounts/${c.external_account_id}/transactions?fromDate=${from}&toDate=${to}&limit=1000`);
        for (const x of t.transactions || []) {
          if (x.status && x.status !== "active") continue;
          rows.push({ date: new Date((x.postedDate || x.transactionDate) * 1000).toISOString().slice(0, 10), amount: Number(x.amount), description: x.description || x.memo,
            ref: x.checkNum ? String(x.checkNum) : null, kind: x.type, external_id: `fin-${x.id}` });
        }
      }
      const { data: res, error } = await user.rpc("import_bank_transactions", { p_account: acct.id, p_rows: rows,
        p_meta: { file_name: `${c.provider} feed`, format: c.provider === "plaid" ? "Plaid" : "Finicity", source: c.provider } });
      if (error) throw new Error(error.message);
      await admin.from("bank_accounts").update({ last_synced_at: new Date().toISOString() }).eq("id", acct.id);
      return json({ ok: true, ...res });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
