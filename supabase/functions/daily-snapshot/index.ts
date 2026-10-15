// Daily snapshot email: preview in the portal, send now, or send a test to yourself.
// Sending uses POSTMARK_SERVER_TOKEN or RESEND_API_KEY (Supabase → Edge Functions → Secrets).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { buildSnapshot, sendSnapshot } from "./snapshot.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY"), { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const body = await req.json();
    // server-to-server: the inbound-email function asks for the snapshot once the night audit is read
    if (body.action === "system_send") {
      const { data: cfg } = await admin.from("app_config").select("value").eq("key", "inbound_token").maybeSingle();
      if (!cfg?.value || req.headers.get("x-akea-token") !== cfg.value) return json({ error: "Not allowed" }, 401);
      return json(await sendSnapshot(admin, body.hotel_id, body.date, String(body.portal || "https://akea-portal.onrender.com")));
    }
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const { action, hotel_id, date, portal } = body;
    // the caller must be able to see this hotel (row-level security decides)
    const { data: h } = await user.from("hotels").select("id,tenant_id").eq("id", hotel_id).maybeSingle();
    if (!h) return json({ error: "Hotel not found." }, 404);
    const portalUrl = String(portal || "https://akea-portal.onrender.com").replace(/\/$/, "");
    if (action === "preview") {
      const s = await buildSnapshot(admin, hotel_id, date, portalUrl);
      return json({ subject: s.subject, html: s.html });
    }
    const { data: lvl } = await user.rpc("perm_level", { t: h.tenant_id, mod: "reports" });
    if ((lvl ?? 0) < 2) return json({ error: "Sending needs report edit rights." }, 403);
    if (action === "test") return json(await sendSnapshot(admin, hotel_id, date, portalUrl, [u.user.email!]));
    if (action === "send") return json(await sendSnapshot(admin, hotel_id, date, portalUrl));
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
