// Inbound report email. Each hotel's PMS emails its nightly reports to that hotel's address
// (e.g. hampton-cleburne@reports.akeahms.com). The email provider forwards each message here:
//   POST https://<project>.supabase.co/functions/v1/inbound-email?token=<INBOUND_TOKEN>
// Works with Postmark (JSON), SendGrid Inbound Parse and Mailgun Routes (multipart form).
// Attachments are stored in the private "reports" bucket, logged, and read into the day's numbers.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import JSZip from "npm:jszip@3.10.1";
import { getDocumentProxy } from "npm:unpdf@0.12.1";
import { parseCsv, parseDate } from "./core.ts";
import { extractReport } from "./extract.ts";

const env = (k: string) => Deno.env.get(k) || "";
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Att = { name: string; type: string; bytes: Uint8Array };
type Mail = { to: string[]; from: string; subject: string; text: string; atts: Att[] };

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const addrs = (s: string) => (s.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase());

async function readMail(req: Request): Promise<Mail> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await req.json(); // Postmark
    const to = [...(j.ToFull || []).map((x: any) => x.Email), ...(j.CcFull || []).map((x: any) => x.Email), ...(j.BccFull || []).map((x: any) => x.Email), j.OriginalRecipient, j.To]
      .filter(Boolean).flatMap((x: string) => addrs(x));
    return { to, from: j.FromFull?.Email || j.From || "", subject: j.Subject || "", text: j.TextBody || (j.HtmlBody || "").replace(/<[^>]+>/g, " "),
      atts: (j.Attachments || []).map((a: any) => ({ name: a.Name, type: a.ContentType || "", bytes: b64(a.Content) })) };
  }
  const f = await req.formData(); // SendGrid / Mailgun
  const atts: Att[] = [];
  for (const [k, v] of f.entries()) if (v instanceof File && /^attachment/i.test(k)) atts.push({ name: v.name, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) });
  const env2 = (() => { try { return JSON.parse(String(f.get("envelope") || "{}")); } catch { return {}; } })();
  const to = [String(f.get("recipient") || ""), String(f.get("to") || ""), String(f.get("cc") || ""), ...(env2.to || [])].flatMap(addrs);
  return { to, from: String(f.get("sender") || f.get("from") || ""), subject: String(f.get("subject") || ""), text: String(f.get("body-plain") || f.get("text") || ""), atts };
}

function guessType(name: string, subject: string): string {
  const n = `${name} ${subject}`.toLowerCase();
  if (n.includes("star") || /\bstr\b/.test(n)) return n.includes("weekly") ? "str_weekly" : "str_monthly";
  if (n.includes("final") && n.includes("audit")) return "final_audit";
  if (/manager'?s?\s*(flash|report|statistics)|daily[\s_]*report|night[\s_]*audit|flash/.test(n)) return "final_audit";
  if (n.includes("aging")) return "direct_bill_aging";
  if (n.includes("forecast")) return "occupancy_forecast";
  if (n.includes("transaction") || n.includes("all charges")) return "all_transactions";
  if (n.includes("clerk") || n.includes("cashier")) return "clerk_activity";
  if (n.includes("segment") || n.includes("recap")) return "revenue_recap_segment";
  if (n.includes("exempt")) return "tax_exempt";
  return "unknown";
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc: any = await getDocumentProxy(bytes);
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as any[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 2.5) * 2.5;
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2.5) ?? y;
      rows.set(key, [...(rows.get(key) || []), { x: it.transform[4], s: it.str }]);
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => lines.push(items.sort((a, b) => a.x - b.x).map((i) => i.s).join("  ")));
  }
  return lines.join("\n");
}
async function xlsxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const shared: string[] = [];
  const ss = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
  const out: string[] = [];
  for (const n of Object.keys(zip.files).filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
    const xml = await zip.file(n)!.async("string");
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map((c) => {
        const v = c[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
        return /t="s"/.test(c[1]) ? shared[+v] ?? "" : v;
      });
      out.push(cells.join("  "));
    }
  }
  return out.join("\n");
}
async function textOf(a: Att): Promise<string> {
  const ext = (a.name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf" || a.type === "application/pdf") return pdfText(a.bytes);
  if (ext === "xlsx" || ext === "xlsm") return xlsxText(a.bytes);
  if (["csv", "txt", "tsv", "prn", "rpt", "xml", "htm", "html"].includes(ext) || a.type.startsWith("text/")) {
    const t = new TextDecoder().decode(a.bytes);
    if (ext === "csv" || ext === "tsv") return parseCsv(t).map((r) => r.join("  ")).join("\n");
    return t.replace(/<[^>]+>/g, " ");
  }
  return "";
}
function businessDate(subject: string, fileName: string, tz: string): string {
  const m = `${subject} ${fileName}`.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|20\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01]))/);
  if (m) {
    const s = /^\d{8}$/.test(m[1]) ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : m[1];
    const d = parseDate(s);
    if (d) return d;
  }
  // night audit runs after midnight, so the report is for the previous day in the hotel's time zone
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const d = new Date(today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method !== "POST") return ok({ ok: true, hint: "POST inbound email here" });
  const { data: cfg } = await admin.from("app_config").select("value").eq("key", "inbound_token").maybeSingle();
  const expected = env("INBOUND_TOKEN") || cfg?.value || "";
  if (!expected || url.searchParams.get("token") !== expected) return ok({ error: "Not allowed" }, 401);
  let mail: Mail;
  try { mail = await readMail(req); } catch (e) { return ok({ error: `Couldn't read the message: ${(e as Error).message}` }, 400); }
  const { data: hotels } = await admin.from("hotels").select("id,tenant_id,name,rooms,timezone,report_email").not("report_email", "is", null);
  // 1) the hotel's own address; 2) the hotel named in the subject (one shared forwarding address works too);
  // 3) the property code printed on the night audit
  const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
  let hotel = (hotels || []).find((h: any) => mail.to.includes(String(h.report_email).toLowerCase()));
  if (!hotel) {
    const subj = norm(mail.subject);
    const { data: full } = await admin.from("hotels").select("id,tenant_id,name,city,rooms,timezone,report_email,property_code");
    hotel = (full || []).find((h: any) => subj.includes(norm(`${h.name} ${h.city || ""}`)) || (h.property_code && new RegExp(`\\b${h.property_code}\\b`, "i").test(mail.subject)));
    if (!hotel) {
      for (const a of mail.atts.filter((x) => /\.pdf$/i.test(x.name)).slice(0, 2)) {
        const code = extractReport(await textOf(a).catch(() => ""), 0).extra?.property_code;
        hotel = code ? (full || []).find((h: any) => String(h.property_code || "").toUpperCase() === code) : undefined;
        if (hotel) break;
      }
    }
  }
  const log = { tenant_id: hotel?.tenant_id || null, hotel_id: hotel?.id || null, to_address: mail.to.join(", ").slice(0, 500), from_address: mail.from.slice(0, 300), subject: mail.subject.slice(0, 500), attachments: mail.atts.length };
  if (!hotel) {
    await admin.from("inbound_emails").insert({ ...log, status: "unmatched", detail: "No hotel uses this address" });
    return ok({ ok: true, matched: false }); // 200 so the provider doesn't retry forever
  }
  const notes: string[] = [];
  let created = 0, failed = 0;
  let snapshotDate: string | null = null;
  // a report pasted in the email body (no attachment) is read too
  const items: Att[] = mail.atts.length ? mail.atts : mail.text.trim().length > 200 ? [{ name: "email-body.txt", type: "text/plain", bytes: new TextEncoder().encode(mail.text) }] : [];
  const seen = new Set<string>();
  for (const a of items) {
    try {
      // the same file attached twice (e.g. "Night_Audit_Report.pdf" and "file.pdf") is read once
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", a.bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (seen.has(hash)) { notes.push(`${a.name}: duplicate attachment skipped`); continue; }
      seen.add(hash);
      let date = businessDate(mail.subject, a.name, hotel.timezone || "America/Chicago");
      let type = guessType(a.name, mail.subject);
      const text = await textOf(a).catch(() => "");
      const g = text.trim() ? extractReport(text, hotel.rooms) : null;
      if (g?.extra?.format) { type = "final_audit"; if (g.business_date) date = g.business_date; }
      const safe = a.name.replace(/[^\w.\- ]+/g, "_");
      const path = `${hotel.tenant_id}/${hotel.id}/${date}/${Date.now()}-${safe}`;
      const up = await admin.storage.from("reports").upload(path, a.bytes, { contentType: a.type || "application/octet-stream", upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data: rep, error } = await admin.from("reports").insert({ tenant_id: hotel.tenant_id, hotel_id: hotel.id, report_type: type, business_date: date, file_name: a.name,
        file_path: path, file_format: (a.name.split(".").pop() || "").toUpperCase(), source: "email", status: "received" }).select("id").single();
      if (error) throw new Error(error.message);
      created++;
      // only a recognised night-audit layout (or a file clearly named as one) updates the day's numbers
      const found = g ? Object.keys(g.values).filter((k) => k !== "rooms_available").length : 0;
      if (g && found && (g.extra?.format || (type === "final_audit" && g.confidence >= 0.8))) {
        await admin.from("reports").update({ extracted: { values: g.values, deposits: g.deposits, business_date_in_file: g.business_date, extra: g.extra || null }, extracted_notes: g.notes }).eq("id", rep.id);
        const r = await admin.rpc("ingest_report_system_v2", { p_report: rep.id, p_values: g.values, p_confidence: g.confidence, p_deposits: Object.keys(g.deposits).length ? g.deposits : null, p_extra: g.extra || null });
        notes.push(`${a.name}: ${r.error ? r.error.message : r.data} (${found} figures${g.extra?.format ? ", " + g.extra.format : ""})`);
        if (!r.error) snapshotDate = date;
      } else {
        await admin.from("reports").update({ status: "processed" }).eq("id", rep.id);
        notes.push(`${a.name}: stored as ${type.replace(/_/g, " ")}`);
      }
    } catch (e) {
      failed++;
      notes.push(`${a.name}: ${(e as Error).message}`);
    }
  }
  // the night audit is in: send the nightly snapshot email to this hotel's list
  if (snapshotDate) {
    try {
      const r = await fetch(`${env("SUPABASE_URL")}/functions/v1/daily-snapshot`, { method: "POST", headers: { "Content-Type": "application/json", "x-akea-token": expected },
        body: JSON.stringify({ action: "system_send", hotel_id: hotel.id, date: snapshotDate, portal: env("PORTAL_URL") || "https://akea-portal.onrender.com" }) });
      const j = await r.json();
      notes.push(j.error ? `snapshot not sent: ${j.error}` : `snapshot: ${j.sent} sent${j.note ? " (" + j.note + ")" : ""}`);
    } catch (e) { notes.push(`snapshot not sent: ${(e as Error).message}`); }
  }
  await admin.from("inbound_emails").insert({ ...log, reports_created: created, status: !items.length ? "failed" : failed ? (created ? "partial" : "failed") : "processed",
    detail: items.length ? notes.join("; ").slice(0, 2000) : "No attachments or report text in the email" });
  return ok({ ok: true, hotel: hotel.name, created, notes });
});
