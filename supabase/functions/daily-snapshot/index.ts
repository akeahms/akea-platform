// Daily snapshot email: preview in the portal, send now, or send a test to yourself.
// Sending uses POSTMARK_SERVER_TOKEN or RESEND_API_KEY (Supabase → Edge Functions → Secrets).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { buildSnapshot, sendSnapshot } from "./snapshot.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sameText = (a: string, b: string) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const env = (k: string) => Deno.env.get(k) || "";
// The link in emails always points at the real portal (never a URL supplied in the request).
const PORTAL = (env("PORTAL_URL") || "https://akea-portal.onrender.com").replace(/\/$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY"), { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    const body = await req.json();
    // server-to-server: the inbound-email function asks for the snapshot once the night audit is read
    if (body.action === "system_send") {
      const { data: cfg } = await admin.from("app_config").select("value").eq("key", "inbound_token").maybeSingle();
      const expected = env("INBOUND_TOKEN") || cfg?.value || "";
      if (!sameText(req.headers.get("x-akea-token") || "", expected)) return json({ error: "Not allowed" }, 401);
      return json(await sendSnapshot(admin, body.hotel_id, body.date, PORTAL));
    }
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const { action, hotel_id, date } = body;
    // the caller must be able to see this hotel (row-level security decides)
    const { data: h } = await user.from("hotels").select("id,tenant_id").eq("id", hotel_id).maybeSingle();
    if (!h) return json({ error: "Hotel not found." }, 404);
    const portalUrl = PORTAL;
    // the snapshot shows revenue, so the caller also needs a numbers permission (dashboards, reports, finance or STR)
    const { data: perf } = await user.rpc("sees_performance", { h: hotel_id });
    if (!perf) return json({ error: "You don't have access to this hotel's figures." }, 403);
    if (action === "preview") {
      const s = await buildSnapshot(admin, hotel_id, date, portalUrl);
      return json({ subject: s.subject, html: s.html });
    }
    const { data: lvl } = await user.rpc("perm_level", { t: h.tenant_id, mod: "reports" });
    if ((lvl ?? 0) < 2) return json({ error: "Sending needs report edit rights." }, 403);
    if (action === "test") {
      if (!u.user.email) return json({ error: "Your sign-in has no email address to send the test to." }, 400);
      return json(await sendSnapshot(admin, hotel_id, date, portalUrl, [u.user.email]));
    }
    if (action === "send") {
      // one send per hotel and day every 10 minutes (stops accidental repeats to the whole list)
      const { data: recent } = await admin.from("snapshot_sends").select("id").eq("hotel_id", hotel_id).eq("business_date", date).eq("status", "sent")
        .gte("sent_at", new Date(Date.now() - 10 * 60_000).toISOString()).limit(1);
      if (recent?.length) return json({ error: "This snapshot was just sent. Wait a few minutes before sending it again." }, 429);
      return json(await sendSnapshot(admin, hotel_id, date, portalUrl));
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("daily-snapshot:", (e as Error).message);
    return json({ error: "Couldn't build or send the snapshot. Try again in a minute." }, 400);
  }
});
