// Bank feeds: Plaid and Finicity. Bank tokens stay server-side in public.bank_connections (no API access for users).
//
// Callers:
//   Portal (signed-in user, Authorization header) — POST { action, bank_account_id, ... }
//   Plaid webhook      — POST ?hook=plaid                (verified with Plaid's signed JWT)
//   Finicity webhook   — POST ?hook=finicity&token=...   (shared secret from app_config.bank_webhook_token)
//   Nightly job        — POST ?action=sync_all with header x-akea-token (pg_cron, 5:30 AM Central)
// Deployed with verify_jwt off because banks can't send a Supabase sign-in; every route checks its own credentials.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  Conn, ProviderError, plaidOn, finicityOn, plaidEnv, finicityEnv, plaid, plaidLinkToken, finicityCustomer, finicityConnectUrl,
  listAccounts, pickAccount, syncConnection, disconnect,
} from "./providers.ts";
import { verifyPlaidWebhook } from "./plaid_verify.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";
const SB_URL = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const admin = createClient(SB_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const background = (p: Promise<unknown>) => { const q = p.catch((e) => console.error("bank-feeds background:", e?.message || e)); if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(q); };

let hookToken: string | null = null;
async function webhookToken() {
  if (hookToken) return hookToken;
  const { data } = await admin.from("app_config").select("value").eq("key", "bank_webhook_token").maybeSingle();
  hookToken = data?.value || "";
  return hookToken!;
}
const plaidHookUrl = () => `${SB_URL}/functions/v1/bank-feeds?hook=plaid`;
const finicityHookUrl = async () => `${SB_URL}/functions/v1/bank-feeds?hook=finicity&token=${await webhookToken()}`;
const sameText = (a: string, b: string) => { if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const getConn = async (accountId: string) => (await admin.from("bank_connections").select("*").eq("bank_account_id", accountId).maybeSingle()).data as Conn | null;

// ------------------------------------------------------------------ Plaid webhook
const plaidKeys = new Map<string, any>();
async function plaidKey(kid: string) {
  if (!plaidKeys.has(kid)) { const j = await plaid("/webhook_verification_key/get", { key_id: kid }); plaidKeys.set(kid, j.key); }
  return plaidKeys.get(kid);
}
async function onPlaidHook(req: Request) {
  const body = await req.text();
  if (!plaidOn() || !(await verifyPlaidWebhook(body, req.headers.get("plaid-verification"), plaidKey))) return json({ error: "Not allowed" }, 401);
  const w = JSON.parse(body);
  const { data: conns } = await admin.from("bank_connections").select("*").eq("provider", "plaid").eq("item_id", w.item_id);
  for (const c of (conns || []) as Conn[]) {
    if (w.webhook_type === "TRANSACTIONS" && ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(w.webhook_code)) {
      if (c.status !== "needs_relogin") background(syncConnection(admin, c));
    } else if (w.webhook_type === "ITEM") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (w.webhook_code === "ERROR" || w.webhook_code === "USER_PERMISSION_REVOKED" || w.webhook_code === "PENDING_DISCONNECT") {
        patch.status = "needs_relogin"; patch.last_error = w.error?.display_message || w.error?.error_message || "The bank needs you to sign in again.";
      } else if (w.webhook_code === "PENDING_EXPIRATION") {
        patch.consent_expires_at = w.consent_expiration_time || null; patch.last_error = "Bank consent expires soon. Reconnect to keep the feed running.";
      } else if (w.webhook_code === "LOGIN_REPAIRED") { patch.status = "active"; patch.last_error = null; background(syncConnection(admin, { ...c, status: "active" })); }
      await admin.from("bank_connections").update(patch).eq("bank_account_id", c.bank_account_id);
    }
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------ Finicity webhook
async function onFinicityHook(req: Request, url: URL) {
  if (!sameText(url.searchParams.get("token") || "", await webhookToken())) return json({ error: "Not allowed" }, 401);
  const w = await req.json().catch(() => ({}));
  const customerId = String(w.customerId || w.payload?.customerId || "");
  if (!customerId) return json({ ok: true });   // ping
  const { data: conns } = await admin.from("bank_connections").select("*").eq("provider", "finicity").eq("customer_id", customerId);
  for (const c of (conns || []) as Conn[]) {
    const ev = String(w.eventType || "");
    if (["added", "done", "discovered", "accountsAdded"].includes(ev)) {
      await admin.from("bank_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() }).eq("bank_account_id", c.bank_account_id);
      background(syncConnection(admin, { ...c, status: "active" }));
    } else if (["unableToConnect", "invalidCredentials", "mfaTimeout"].includes(ev)) {
      await admin.from("bank_connections").update({ status: "needs_relogin", last_error: "The bank sign-in didn't finish. Reconnect to try again.", updated_at: new Date().toISOString() }).eq("bank_account_id", c.bank_account_id);
    }
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------ nightly job
async function syncAll() {
  const { data: conns } = await admin.from("bank_connections").select("*").in("status", ["active", "error"]);
  let ok = 0, failed = 0;
  for (const c of (conns || []) as Conn[]) {
    try { await syncConnection(admin, c, { refresh: true }); ok++; } catch { failed++; }
  }
  console.log(`bank-feeds nightly: ${ok} synced, ${failed} failed`);
}

// ------------------------------------------------------------------ portal actions
const NEEDS: Record<string, number> = { accounts: 2, sync: 2, plaid_link_token: 3, plaid_exchange: 3, finicity_connect_url: 3, choose_account: 3, disconnect: 3 };

async function onPortal(req: Request) {
  const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  if (action === "status") {
    return json({
      configured: { plaid: plaidOn(), finicity: finicityOn() }, environments: { plaid: plaidEnv(), finicity: finicityEnv() },
      message: plaidOn() || finicityOn()
        ? `Bank feeds are on (${[plaidOn() && `Plaid ${plaidEnv()}`, finicityOn() && `Finicity ${finicityEnv()}`].filter(Boolean).join(" and ")}). Choose an account and connect it.`
        : "Bank feeds aren't switched on yet. Add your Plaid and/or Finicity keys in Supabase → Edge Functions → Secrets, then connect each bank here. Until then, upload statements in any format.",
    });
  }
  if (!(action in NEEDS)) return json({ error: "Unknown action" }, 400);

  // the caller must be able to see this bank account (row-level security) and hold enough finance rights
  const { data: acct } = await user.from("bank_accounts").select("id,tenant_id,hotel_id,name,last4,institution").eq("id", body.bank_account_id).maybeSingle();
  if (!acct) return json({ error: "Bank account not found." }, 404);
  const { data: lvl } = await user.rpc("perm_level", { t: acct.tenant_id, mod: "finance" });
  if ((lvl ?? 0) < NEEDS[action]) return json({ error: NEEDS[action] >= 3 ? "Connecting bank feeds needs finance approval rights." : "This needs finance edit rights." }, 403);
  const conn = await getConn(acct.id);

  if (action === "plaid_link_token") {
    if (!plaidOn()) return json({ error: "Plaid isn't switched on. Add PLAID_CLIENT_ID and PLAID_SECRET in Supabase secrets." }, 400);
    const relink = !!body.relink && conn?.provider === "plaid" && conn.access_token;
    const { data: tn } = await admin.from("tenants").select("product_name,brand_name,name").eq("id", acct.tenant_id).maybeSingle();
    const shown = tn?.product_name || tn?.brand_name || tn?.name || "Hotel operations";   // the name people see in the bank sign-in window
    return json({ link_token: await plaidLinkToken(u.user.id, plaidHookUrl(), relink ? conn!.access_token : null, shown), relink: !!relink });
  }

  if (action === "plaid_exchange") {
    if (!body.public_token) return json({ error: "Missing public token" }, 400);
    if (conn && conn.provider === "plaid" && body.relink) {           // update mode: same item, nothing to exchange
      await admin.from("bank_connections").update({ status: "active", last_error: null }).eq("bank_account_id", acct.id);
      const r = await syncConnection(admin, { ...conn, status: "active" });
      return json({ ok: true, ...r });
    }
    // exchange first; only once the new link works is the older one removed (a failure leaves the old link in place)
    const ex = await plaid("/item/public_token/exchange", { public_token: body.public_token });
    if (conn) await disconnect(conn).catch((e) => console.error("bank-feeds: old link not removed:", (e as Error).message));
    const c: Conn = { bank_account_id: acct.id, tenant_id: acct.tenant_id, provider: "plaid", status: "active", item_id: ex.item_id, access_token: ex.access_token,
      external_account_id: null, customer_id: null, cursor: null, institution: body.institution || null, last_synced_at: null };
    const accts = await listAccounts(c);
    const chosen = accts.find((a) => a.id === body.plaid_account_id) || pickAccount(accts, acct.last4);
    c.external_account_id = chosen?.id || null;
    const { error } = await admin.from("bank_connections").upsert({ ...c, account_name: chosen?.name || null, account_mask: chosen?.mask || null, last_error: null,
      created_by: u.user.id, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    await admin.from("bank_accounts").update({ feed: "plaid" }).eq("id", acct.id);
    const r = await syncConnection(admin, c);
    return json({ ok: true, accounts: accts, linked: c.external_account_id, ...r });
  }

  if (action === "finicity_connect_url") {
    if (!finicityOn()) return json({ error: "Finicity isn't switched on. Add FINICITY_PARTNER_ID, FINICITY_SECRET and FINICITY_APP_KEY in Supabase secrets." }, 400);
    let c = conn;
    if (c && c.provider !== "finicity") { await disconnect(c); await admin.from("bank_connections").delete().eq("bank_account_id", acct.id); c = null; }
    if (!c) {
      const customerId = await finicityCustomer(`akea-${acct.id}`, acct.name);
      const { error } = await admin.from("bank_connections").upsert({ bank_account_id: acct.id, tenant_id: acct.tenant_id, provider: "finicity", customer_id: customerId,
        status: "pending", created_by: u.user.id, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
      c = await getConn(acct.id);
    }
    // reconnect an existing login when we know it, otherwise a fresh Connect session
    let loginId: string | null = null;
    if (body.relink && c!.external_account_id) loginId = (await listAccounts(c!).catch(() => [])).find((a) => a.id === c!.external_account_id)?.login_id || null;
    const url = await finicityConnectUrl(c!.customer_id!, await finicityHookUrl(), loginId);
    return json({ url });
  }

  if (!conn) return json({ error: "This account isn't connected to a bank feed yet." }, 400);

  if (action === "accounts") {
    const accts = await listAccounts(conn);
    return json({ accounts: accts.map(({ login_id: _l, ...a }) => a), linked: conn.external_account_id });
  }
  if (action === "choose_account") {
    const accts = await listAccounts(conn);
    const a = accts.find((x) => x.id === String(body.external_account_id));
    if (!a) return json({ error: "That account isn't part of this bank connection." }, 400);
    await admin.from("bank_connections").update({ external_account_id: a.id, account_name: a.name, account_mask: a.mask, cursor: null, last_synced_at: null }).eq("bank_account_id", acct.id);
    const r = await syncConnection(admin, { ...conn, external_account_id: a.id, cursor: null, last_synced_at: null });
    return json({ ok: true, ...r });
  }
  if (action === "sync") {
    if (conn.status === "pending") return json({ error: "Finish signing in to the bank in the Finicity window first." }, 400);
    const r = await syncConnection(admin, conn, { refresh: true });
    return json({ ok: true, ...r });
  }
  if (action === "disconnect") {
    await disconnect(conn);
    await admin.from("bank_connections").delete().eq("bank_account_id", acct.id);
    await admin.from("bank_accounts").update({ feed: "manual" }).eq("id", acct.id);
    await admin.from("audit_log").insert({ tenant_id: acct.tenant_id, user_id: u.user.id, action: "disconnect", object_type: "bank_feed", object_id: acct.id, detail: { provider: conn.provider } });
    return json({ ok: true });
  }
  return json({ error: "Unknown action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("hook") === "plaid") return await onPlaidHook(req);
    if (url.searchParams.get("hook") === "finicity") return await onFinicityHook(req, url);
    if (url.searchParams.get("action") === "sync_all") {
      if (!sameText(req.headers.get("x-akea-token") || "", await webhookToken())) return json({ error: "Not allowed" }, 401);
      background(syncAll());
      return json({ ok: true, started: true });
    }
    return await onPortal(req);
  } catch (e) {
    const pe = e as ProviderError;
    console.error("bank-feeds:", pe.message);
    // the bank provider's own messages help the user; anything else (database etc.) stays in the logs
    return json({ error: pe instanceof ProviderError ? pe.message : "Something went wrong with the bank connection. Try again.", code: pe.code || null, relogin: !!pe.relogin }, pe.relogin ? 409 : 400);
  }
});
