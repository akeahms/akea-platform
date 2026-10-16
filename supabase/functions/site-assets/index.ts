// One-time copy of the company's own website images from Wix's image servers into the public "site" storage bucket,
// so the rebuilt website doesn't depend on Wix. Server-to-server only (token in app_config.site_import_token).
// POST { tenant_slug, urls: ["https://static.wixstatic.com/media/....png", ...] }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const env = (k: string) => Deno.env.get(k) || "";
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const sameText = (a: string, b: string) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const { data: cfg } = await admin.from("app_config").select("value").eq("key", "site_import_token").maybeSingle();
  if (!sameText(req.headers.get("x-akea-token") || "", cfg?.value || "")) return json({ error: "Not allowed" }, 401);
  const body = await req.json().catch(() => ({}));
  const slug = String(body.tenant_slug || "").replace(/[^a-z0-9-]/g, "");
  const urls: string[] = Array.isArray(body.urls) ? body.urls.slice(0, 60) : [];
  if (!slug || !urls.length) return json({ error: "tenant_slug and urls needed" }, 400);
  const out: Record<string, string> = {}; const errors: Record<string, string> = {};
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (url.hostname !== "static.wixstatic.com" || !url.pathname.startsWith("/media/")) throw new Error("only Wix media URLs");
      const file = url.pathname.split("/")[2];
      const ext = (file.split(".").pop() || "").toLowerCase();
      if (!TYPES[ext]) throw new Error("not an image");
      // photos are resized to at most 2000px wide by Wix's own image service; logos/icons are copied as they are
      const src = ext === "png" || ext === "webp" ? u : `https://static.wixstatic.com/media/${file}/v1/fit/w_2000,h_2000,q_82/${file}`;
      const r = await fetch(src);
      if (!r.ok) throw new Error(`download ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 9 * 1024 * 1024) throw new Error("too large");
      const name = file.replace(/~mv2/, "").replace(/[^A-Za-z0-9._-]/g, "_");
      const path = `${slug}/${name}`;
      const up = await admin.storage.from("site").upload(path, bytes, { contentType: TYPES[ext], upsert: true, cacheControl: "31536000" });
      if (up.error) throw new Error(up.error.message);
      out[u] = `${env("SUPABASE_URL")}/storage/v1/object/public/site/${path}`;
    } catch (e) { errors[u] = (e as Error).message; }
  }
  return json({ ok: true, copied: Object.keys(out).length, map: out, errors });
});
