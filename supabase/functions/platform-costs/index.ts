// Platform costs: pulls provider costs that have an API (today: Anthropic, for Ask AI) into platform_invoices.
// Callers:
//   Portal (signed-in user with the Platform costs permission) — POST { action: "status" | "sync", tenant_id }
//   Morning job — POST ?action=sync_all with header x-akea-token (pg_cron)
// Invoice emails are handled by the inbound-email function (billing address).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { anthropicMonthlyCosts } from "./anthropic.ts";

const env = (k: string) => Deno.env.get(k) || "";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const sameText = (a: string, b: string) => { if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const KEY = () => env("ANTHROPIC_ADMIN_KEY");

/** Last month and this month from Anthropic, written as one row per month (re-running updates the same rows). */
async function syncTenant(tenant: string) {
  const { data: svc } = await admin.from("platform_services").select("id").eq("tenant_id", tenant).eq("feed", "api").ilike("name", "anthropic%").maybeSingle();
  if (!svc) return { months: 0, note: "No Anthropic service set to pull from the API." };
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  try {
    const months = await anthropicMonthlyCosts(KEY(), from, now);
    const thisMonth = now.toISOString().slice(0, 7);
    for (const m of months) {
      const last = new Date(Date.UTC(+m.month.slice(0, 4), +m.month.slice(5, 7), 0)).toISOString().slice(0, 10);
      const { error } = await admin.from("platform_invoices").upsert({
        tenant_id: tenant, service_id: svc.id, invoice_no: null, invoice_date: m.month === thisMonth ? now.toISOString().slice(0, 10) : last,
        period_month: `${m.month}-01`, amount: m.amount, currency: "USD", status: m.month === thisMonth ? "accruing" : "paid", source: "api",
        external_key: `api:anthropic:${m.month}`, note: m.month === thisMonth ? `Month to date (${m.days} days), from Anthropic's cost report` : "From Anthropic's cost report",
        updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,external_key" });
      if (error) throw new Error(error.message);
    }
    await admin.from("platform_cost_settings").upsert({ tenant_id: tenant, anthropic_last_sync: new Date().toISOString(), anthropic_last_error: null, updated_at: new Date().toISOString() });
    return { months: months.length };
  } catch (e) {
    await admin.from("platform_cost_settings").upsert({ tenant_id: tenant, anthropic_last_error: String((e as Error).message).slice(0, 400), updated_at: new Date().toISOString() });
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("action") === "sync_all") {
      const { data } = await admin.from("app_config").select("value").eq("key", "platform_job_token").maybeSingle();
      if (!sameText(req.headers.get("x-akea-token") || "", data?.value || "")) return json({ error: "Not allowed" }, 401);
      if (!KEY()) return json({ ok: true, skipped: "ANTHROPIC_ADMIN_KEY not set" });
      const { data: svcs } = await admin.from("platform_services").select("tenant_id").eq("feed", "api").ilike("name", "anthropic%");
      let ok = 0, failed = 0;
      for (const t of new Set((svcs || []).map((s: any) => s.tenant_id))) { try { await syncTenant(t as string); ok++; } catch { failed++; } }
      return json({ ok: true, synced: ok, failed });
    }
    const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY"), { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));
    const tenant = String(body.tenant_id || "");
    // perm_level runs as the signed-in user, so it only answers for companies they belong to
    const { data: lvl } = await user.rpc("perm_level", { t: tenant, mod: "platform_costs" });
    if ((lvl ?? 0) < 1) return json({ error: "Platform costs isn't turned on for your role." }, 403);
    if (body.action === "status") return json({ anthropic: !!KEY() });
    if (body.action === "sync") {
      if ((lvl ?? 0) < 2) return json({ error: "Updating platform costs needs edit rights." }, 403);
      if (!KEY()) return json({ error: "Anthropic isn't connected yet. Add an Admin API key as ANTHROPIC_ADMIN_KEY in Supabase → Edge Functions → Secrets." }, 400);
      return json({ ok: true, ...(await syncTenant(tenant)) });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("platform-costs:", (e as Error).message);
    return json({ error: "Couldn't update platform costs. Check the Anthropic connection on the Automatic invoices tab." }, 400);
  }
});
