// The company website's forms (contact + job application) → website_submissions, résumés into the private
// "applicants" bucket, and a short notification email. Public endpoint (no sign-in), so it defends itself:
// only the company's own web addresses may post, a hidden honeypot field and a minimum time on the page catch bots,
// 5 submissions per visitor per hour, strict field limits, and résumés must really be PDF or Word files.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string) => Deno.env.get(k) || "";
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const EMAIL = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);

function cors(origin: string | null, allowed: boolean) {
  return { "Access-Control-Allow-Origin": allowed && origin ? origin : "null", "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type", Vary: "Origin" };
}
async function sha(s: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** PDF, old Word (.doc) or new Word (.docx) by their first bytes; anything else is refused. */
function resumeType(b: Uint8Array): [string, string] | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return ["application/pdf", "pdf"];
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return ["application/msword", "doc"];
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"];
  return null;
}
async function notify(to: string | null, fromName: string, subject: string, rows: [string, string][]) {
  const pm = env("POSTMARK_SERVER_TOKEN");
  if (!to || !pm) return false;
  const html = `<div style="font:15px/1.5 system-ui,sans-serif"><h2 style="margin:0 0 12px">${esc(subject)}</h2><table>${rows.filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>`).join("")}</table>
    <p style="color:#666;font-size:13px">Open the suite to reply or update its status.</p></div>`;
  const r = await fetch("https://api.postmarkapp.com/email", { method: "POST", headers: { "X-Postmark-Server-Token": pm, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ From: `${fromName.replace(/[\r\n<>"]/g, " ")} <${env("WEBSITE_FROM") || "reports@akeahms.com"}>`, To: to, Subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200), HtmlBody: html, MessageStream: "outbound" }) });
  return r.ok;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  let host = "";
  try { host = origin ? new URL(origin).hostname.toLowerCase() : ""; } catch { host = ""; }
  // which company's website is this? (white-label: each company lists its own web addresses)
  const { data: tenants } = await admin.from("tenants").select("id,name,brand_name,site_domains,site_contact_email,site_careers_email");
  const tenant = (tenants || []).find((t: any) => (t.site_domains || []).map((d: string) => d.toLowerCase()).includes(host));
  const h = cors(origin, !!tenant);
  const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return reply({ error: "Not found" }, 404);
  if (!tenant) return reply({ error: "This form can only be sent from the company's website." }, 403);
  if (Number(req.headers.get("content-length") || 0) > 6 * 1024 * 1024) return reply({ error: "That's too large. Résumés can be up to 5 MB." }, 413);

  let f: Record<string, any> = {};
  let file: File | null = null;
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) { if (v instanceof File) { if (k === "resume") file = v; } else f[k] = v; }
    } else f = await req.json();
  } catch { return reply({ error: "Couldn't read the form. Please try again." }, 400); }

  const kind = f.kind === "application" ? "application" : "contact";
  // bots: the hidden field gets filled, or the form is sent impossibly fast. Pretend it worked.
  const elapsed = Date.now() - Number(f.started || 0);
  if (clean(f.website, 200) || !(elapsed > 2500 && elapsed < 6 * 3600_000)) return reply({ ok: true });

  const email = clean(f.email, 254);
  if (!EMAIL.test(email)) return reply({ error: "Please enter a valid email address." }, 400);
  const row: Record<string, unknown> = {
    tenant_id: tenant.id, kind, email, first_name: clean(f.first_name, 80) || null, last_name: clean(f.last_name, 80) || null,
    phone: clean(f.phone, 40).replace(/[^\d+()\-.\s]/g, "") || null, page: clean(f.page, 200) || null,
  };
  if (kind === "contact") {
    row.message = clean(f.message, 5000);
    if (!row.first_name || !row.phone || !row.message) return reply({ error: "Please fill in your name, phone, email and message." }, 400);
  } else {
    row.position = clean(f.position, 150);
    const li = clean(f.linkedin, 300);
    if (li && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(li)) return reply({ error: "The LinkedIn link should start with https://www.linkedin.com/" }, 400);
    row.linkedin = li || null;
    if (!row.position) return reply({ error: "Please tell us which position you're applying for." }, 400);
    if (!file || !file.size) return reply({ error: "Please attach your résumé (PDF or Word, up to 5 MB)." }, 400);
    if (file.size > 5 * 1024 * 1024) return reply({ error: "Résumés can be up to 5 MB." }, 413);
  }

  // at most 5 submissions per visitor per hour (the address itself is never stored, only a one-way hash)
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const ipHash = (await sha(`${ip}|${tenant.id}|${env("SUPABASE_URL")}`)).slice(0, 32);
  const { count } = await admin.from("website_submissions").select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((count || 0) >= 5) return reply({ error: "We've received several messages from you just now. Please try again in an hour, or email us directly." }, 429);
  row.ip_hash = ipHash;

  if (kind === "application" && file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const t = resumeType(bytes);
    if (!t) return reply({ error: "Please attach your résumé as a PDF or Word file." }, 400);
    const path = `${tenant.id}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${t[1]}`;
    const up = await admin.storage.from("applicants").upload(path, bytes, { contentType: t[0], upsert: false });
    if (up.error) { console.error("website: résumé upload", up.error.message); return reply({ error: "Couldn't save your résumé. Please try again." }, 500); }
    row.resume_path = path;
    row.resume_name = clean(file.name, 150).replace(/[^\w.\- ()]+/g, "_");
  }

  const { data: saved, error } = await admin.from("website_submissions").insert(row).select("id").single();
  if (error) { console.error("website: save", error.message); return reply({ error: "Couldn't send that just now. Please try again or email us." }, 500); }

  const brand = tenant.brand_name || tenant.name;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || email;
  try {
    const ok = kind === "contact"
      ? await notify(tenant.site_contact_email, brand, `New website enquiry from ${name}`, [["Name", name], ["Email", email], ["Phone", String(row.phone || "")], ["Message", String(row.message || "")]])
      : await notify(tenant.site_careers_email || tenant.site_contact_email, brand, `New job application: ${row.position} — ${name}`,
          [["Name", name], ["Email", email], ["Phone", String(row.phone || "")], ["Position", String(row.position)], ["LinkedIn", String(row.linkedin || "")], ["Résumé", "Attached in the suite (Website → Job applicants)"]]);
    if (ok) await admin.from("website_submissions").update({ notified: true }).eq("id", saved.id);
  } catch (e) { console.error("website: notify", (e as Error).message); }
  return reply({ ok: true });
});
