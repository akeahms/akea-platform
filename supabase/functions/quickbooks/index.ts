// QuickBooks Online integration.
//
// Callers:
//   Portal (signed-in user)  — POST { action, hotel_id }: connect_url, refresh_accounts, auto_map, sync, disconnect, status
//   Intuit sign-in redirect  — GET  /quickbooks/callback?code&state&realmId  (state ties it to the user and hotel)
//   Nightly job              — POST ?action=sync_all with header x-akea-token (pg_cron, 6:45 AM Central)
// Deployed with verify_jwt off because Intuit's browser redirect carries no Supabase sign-in; every route checks its own credentials.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { Conn, QboError, qboOn, qboEnv, authorizeUrl, exchangeCode, revoke, qbo, pullAccounts, suggestMap, syncHotel } from "./qbo.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";
const SB_URL = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const PORTAL = (env("PORTAL_URL") || "https://akea-portal.onrender.com").replace(/\/$/, "");
const REDIRECT = `${SB_URL}/functions/v1/quickbooks/callback`;
const admin = createClient(SB_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const background = (p: Promise<unknown>) => { const q = p.catch((e) => console.error("quickbooks background:", e?.message || e)); if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(q); };
const sameText = (a: string, b: string) => { if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const back = (status: string, hotel?: string) => Response.redirect(`${PORTAL}/#accounting?qbo=${status}${hotel ? `&hotel=${hotel}` : ""}`, 302);
const getConn = async (hotelId: string) => (await admin.from("qbo_connections").select("*").eq("hotel_id", hotelId).maybeSingle()).data as Conn | null;

/** "Yesterday" in the hotel's own time zone: the latest night audit that can be complete. */
function yesterdayIn(tz: string) {
  const d = new Date(Date.now() - 864e5);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function runSync(c: Conn) {
  const { data: h } = await admin.from("hotels").select("timezone").eq("id", c.hotel_id).single();
  try {
    const counts = await syncHotel(admin, c, { yesterday: yesterdayIn(h?.timezone) });
    await admin.from("qbo_connections").update({ status: "active", last_error: counts.failed ? `${counts.failed} item(s) couldn't be sent. See the sync log.` : null,
      last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("hotel_id", c.hotel_id);
    return counts;
  } catch (e) {
    const q = e as QboError;
    await admin.from("qbo_connections").update({ status: q.relogin ? "needs_relogin" : "error", last_error: String(q.message).slice(0, 400), updated_at: new Date().toISOString() }).eq("hotel_id", c.hotel_id);
    throw e;
  }
}

/** Mappings and the sync log belong to one QuickBooks company; clear them when the hotel leaves it. */
async function forgetCompany(hotelId: string) {
  for (const t of ["qbo_account_map", "qbo_vendor_map", "qbo_sync_log", "qbo_accounts"]) await admin.from(t).delete().eq("hotel_id", hotelId);
}

// ------------------------------------------------------------------ Intuit redirect after sign-in
async function onCallback(url: URL) {
  const state = url.searchParams.get("state") || "";
  // take the state once (delete-and-return), so a sign-in link can't be replayed
  const { data: taken } = state ? await admin.from("qbo_oauth_states").delete().eq("state", state).select("*") : { data: null };
  const st = taken?.[0];
  if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60 * 1000) return back("expired");
  if (url.searchParams.get("error")) return back("cancelled", st.hotel_id);
  const code = url.searchParams.get("code"), realm = url.searchParams.get("realmId");
  if (!code || !realm || !/^\d{1,20}$/.test(realm)) return back("failed", st.hotel_id);
  try {
    const { data: hotel } = await admin.from("hotels").select("id,tenant_id").eq("id", st.hotel_id).single();
    const old = await getConn(st.hotel_id);
    const t = await exchangeCode(code, REDIRECT);
    if (old && old.realm_id !== realm) await revoke(old.refresh_token);
    // a different QuickBooks company than last time: the old company's account/vendor ids and "already sent" log don't apply
    const { data: prev } = await admin.from("qbo_settings").select("realm_id").eq("hotel_id", hotel.id).maybeSingle();
    const lastRealm = old?.realm_id || prev?.realm_id;
    if (lastRealm && lastRealm !== realm) await forgetCompany(hotel.id);
    const c: Conn = { hotel_id: hotel.id, tenant_id: hotel.tenant_id, realm_id: realm, company_name: null, status: "active", ...t };
    const { error } = await admin.from("qbo_connections").upsert({ ...c, last_error: null, connected_by: st.user_id, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    const info = await qbo(admin, c, "GET", `companyinfo/${realm}`).catch(() => null);
    await admin.from("qbo_connections").update({ company_name: info?.CompanyInfo?.CompanyName || null }).eq("hotel_id", hotel.id);
    await admin.from("qbo_settings").upsert({ hotel_id: hotel.id, tenant_id: hotel.tenant_id }, { onConflict: "hotel_id", ignoreDuplicates: true });
    await admin.from("qbo_settings").update({ realm_id: realm }).eq("hotel_id", hotel.id);
    await pullAccounts(admin, c);
    await admin.from("audit_log").insert({ tenant_id: hotel.tenant_id, user_id: st.user_id, action: "connect", object_type: "quickbooks", object_id: hotel.id, detail: { realm } });
    return back("connected", hotel.id);
  } catch (e) {
    console.error("quickbooks callback:", (e as Error).message);
    return back("failed", st.hotel_id);
  }
}

// ------------------------------------------------------------------ portal actions
const NEEDS: Record<string, number> = { connect_url: 3, refresh_accounts: 2, auto_map: 3, sync: 2, disconnect: 3 };

async function onPortal(req: Request) {
  const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  if (action === "config") return json({ configured: qboOn(), environment: qboEnv() });
  if (!(action in NEEDS)) return json({ error: "Unknown action" }, 400);

  const { data: hotel } = await user.from("hotels").select("id,tenant_id,name").eq("id", body.hotel_id).maybeSingle();
  if (!hotel) return json({ error: "Hotel not found." }, 404);
  const { data: lvl } = await user.rpc("perm_level", { t: hotel.tenant_id, mod: "finance" });
  if ((lvl ?? 0) < NEEDS[action]) return json({ error: NEEDS[action] >= 3 ? "Connecting QuickBooks needs finance approval rights." : "This needs finance edit rights." }, 403);
  if (!qboOn()) return json({ error: "QuickBooks isn't switched on yet. Add QBO_CLIENT_ID and QBO_CLIENT_SECRET in Supabase → Edge Functions → Secrets." }, 400);

  if (action === "connect_url") {
    const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await admin.from("qbo_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
    const { error } = await admin.from("qbo_oauth_states").insert({ state, hotel_id: hotel.id, user_id: u.user.id });
    if (error) throw new Error(error.message);
    return json({ url: authorizeUrl(REDIRECT, state) });
  }

  const c = await getConn(hotel.id);
  if (!c) return json({ error: `${hotel.name} isn't connected to QuickBooks yet.` }, 400);

  if (action === "refresh_accounts") return json({ ok: true, accounts: await pullAccounts(admin, c) });
  if (action === "auto_map") {
    const [{ data: gls }, { data: qas }, { data: maps }] = await Promise.all([
      admin.from("gl_accounts").select("id,number,name,type,full_name").eq("hotel_id", hotel.id).eq("active", true),
      admin.from("qbo_accounts").select("qbo_id,name,full_name,acct_num,account_type").eq("hotel_id", hotel.id),
      admin.from("qbo_account_map").select("gl_account_id").eq("hotel_id", hotel.id),
    ]);
    const have = new Set((maps || []).map((m: any) => m.gl_account_id));
    const sug = suggestMap((gls || []).filter((g: any) => !have.has(g.id)), qas || []);
    const rows = [...sug.entries()].map(([gl, q]) => ({ hotel_id: hotel.id, tenant_id: hotel.tenant_id, gl_account_id: gl, qbo_account_id: q, updated_at: new Date().toISOString() }));
    if (rows.length) { const { error } = await admin.from("qbo_account_map").insert(rows); if (error) throw new Error(error.message); }
    return json({ ok: true, matched: rows.length, unmatched: (gls || []).length - have.size - rows.length });
  }
  if (action === "sync") {
    if (c.status === "needs_relogin") return json({ error: "QuickBooks needs you to sign in again. Use Reconnect." }, 409);
    return json({ ok: true, ...(await runSync(c)) });
  }
  if (action === "disconnect") {
    await revoke(c.refresh_token);
    await admin.from("qbo_connections").delete().eq("hotel_id", hotel.id);
    await admin.from("qbo_accounts").delete().eq("hotel_id", hotel.id);   // mapping and log are kept for reconnecting to the same company
    await admin.from("audit_log").insert({ tenant_id: hotel.tenant_id, user_id: u.user.id, action: "disconnect", object_type: "quickbooks", object_id: hotel.id, detail: { realm: c.realm_id } });
    return json({ ok: true });
  }
  return json({ error: "Unknown action" }, 400);
}

// ------------------------------------------------------------------ nightly job
async function syncAll() {
  const { data: conns } = await admin.from("qbo_connections").select("*").in("status", ["active", "error"]);
  let ok = 0, failed = 0;
  for (const c of (conns || []) as Conn[]) { try { await runSync(c); ok++; } catch { failed++; } }
  console.log(`quickbooks nightly: ${ok} hotels synced, ${failed} failed`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname.endsWith("/callback")) return await onCallback(url);
    if (url.searchParams.get("action") === "sync_all") {
      const { data } = await admin.from("app_config").select("value").eq("key", "qbo_job_token").maybeSingle();
      if (!sameText(req.headers.get("x-akea-token") || "", data?.value || "")) return json({ error: "Not allowed" }, 401);
      background(syncAll());
      return json({ ok: true, started: true });
    }
    return await onPortal(req);
  } catch (e) {
    const q = e as QboError;
    console.error("quickbooks:", q.message);
    // QuickBooks' own messages are useful to the user; database errors are not shown
    return json({ error: q instanceof QboError ? q.message : "Something went wrong talking to QuickBooks. Try again, or check the sync log.", relogin: !!q.relogin }, q.relogin ? 409 : 400);
  }
});
