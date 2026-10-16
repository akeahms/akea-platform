// Inbound email. Each company has one report inbox (Akea: reports@akeahms.com); every hotel's PMS sends its nightly
// reports there, and the hotel is identified from the report itself (property code printed on the night audit, or the
// hotel's name in the subject) among that company's hotels only. A company's billing address (billing@akeahms.com)
// goes to Platform costs instead. The email provider forwards each message here:
//   POST https://<project>.supabase.co/functions/v1/inbound-email   header x-akea-token: <INBOUND_TOKEN>  (or ?token=)
// Works with Postmark (JSON), SendGrid Inbound Parse and Mailgun Routes (multipart form).
// Attachments are stored in the private "reports" bucket, logged, and read into the day's numbers.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import JSZip from "npm:jszip@3.10.1";
import { getDocumentProxy } from "npm:unpdf@0.12.1";
import { parseCsv, parseDate } from "./core.ts";
import { extractReport } from "./extract.ts";
import { readPlatformInvoice } from "./platform_invoice.ts";
import { matchHotel, dateInWindow, senderAllowed, sameText } from "./hotel_match.ts";

const env = (k: string) => Deno.env.get(k) || "";
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Att = { name: string; type: string; bytes: Uint8Array };
type Mail = { to: string[]; from: string; subject: string; text: string; atts: Att[]; messageId: string | null; skipped: string[] };
const MAX_ATTS = 10, MAX_BYTES = 15 * 1024 * 1024, MAX_PAGES = 60, MAX_XLSX = 30 * 1024 * 1024;
/** Keep at most 10 attachments of up to 15 MB each; note what was skipped. */
function capAtts(atts: Att[], skipped: string[]) {
  const out: Att[] = [];
  for (const a of atts) {
    if (out.length >= MAX_ATTS) { skipped.push(`${a.name}: more than ${MAX_ATTS} attachments`); continue; }
    if (a.bytes.length > MAX_BYTES) { skipped.push(`${a.name}: larger than 15 MB`); continue; }
    out.push(a);
  }
  return out;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const addrs = (s: string) => (s.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase());

async function readMail(req: Request): Promise<Mail> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await req.json(); // Postmark
    const to = [...(j.ToFull || []).map((x: any) => x.Email), ...(j.CcFull || []).map((x: any) => x.Email), ...(j.BccFull || []).map((x: any) => x.Email), j.OriginalRecipient, j.To]
      .filter(Boolean).flatMap((x: string) => addrs(x));
    const skipped: string[] = [];
    const raw = (j.Attachments || []).slice(0, MAX_ATTS + 5).filter((a: any) => (a.ContentLength ?? (a.Content || "").length * 0.75) <= MAX_BYTES || (skipped.push(`${a.Name}: larger than 15 MB`), false));
    return { to, from: j.FromFull?.Email || j.From || "", subject: j.Subject || "", text: (j.TextBody || (j.HtmlBody || "").replace(/<[^>]+>/g, " ")).slice(0, 200_000),
      atts: capAtts(raw.map((a: any) => ({ name: String(a.Name || "file"), type: a.ContentType || "", bytes: b64(a.Content || "") })), skipped), messageId: j.MessageID || null, skipped };
  }
  const f = await req.formData(); // SendGrid / Mailgun
  const atts: Att[] = [];
  for (const [k, v] of f.entries()) if (v instanceof File && /^attachment/i.test(k) && atts.length <= MAX_ATTS && v.size <= MAX_BYTES) atts.push({ name: v.name, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) });
  const env2 = (() => { try { return JSON.parse(String(f.get("envelope") || "{}")); } catch { return {}; } })();
  const to = [String(f.get("recipient") || ""), String(f.get("to") || ""), String(f.get("cc") || ""), ...(env2.to || [])].flatMap(addrs);
  const skipped: string[] = [];
  return { to, from: String(f.get("sender") || f.get("from") || ""), subject: String(f.get("subject") || ""), text: String(f.get("body-plain") || f.get("text") || "").slice(0, 200_000),
    atts: capAtts(atts, skipped), messageId: String(f.get("Message-Id") || f.get("message-id") || "") || null, skipped };
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
  for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGES); p++) {
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
  // refuse a "zip bomb": a small file that expands to gigabytes
  const total = Object.values(zip.files).reduce((a: number, f: any) => a + (f._data?.uncompressedSize || 0), 0);
  if (total > MAX_XLSX) throw new Error("spreadsheet expands to more than 30 MB");
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

const sha = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b))).map((x) => x.toString(16).padStart(2, "0")).join("");

/** A forwarded software invoice/receipt → platform_invoices (needs-review when the service or amount isn't clear). */
async function platformInvoice(tenant: string, billingEmail: string, mail: Mail) {
  const { data: svcs } = await admin.from("platform_services").select("id,name,match_terms").eq("tenant_id", tenant).eq("active", true);
  const pdfs = mail.atts.filter((a) => /\.pdf$/i.test(a.name) || a.type === "application/pdf").slice(0, 3);
  let text = mail.text;
  let g = readPlatformInvoice(svcs || [], mail.from, mail.subject, text, [billingEmail]);
  // the email body is often just "your invoice is attached": read the PDF too
  for (const a of pdfs) {
    if (g.amount != null && g.service_id && g.invoice_date) break;
    text += "\n" + (await textOf(a).catch(() => ""));
    g = readPlatformInvoice(svcs || [], mail.from, mail.subject, text, [billingEmail]);
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = g.invoice_date || today;
  let file_path: string | null = null;
  if (pdfs[0] && pdfs[0].bytes.length <= 15 * 1024 * 1024) {
    const path = `${tenant}/platform-costs/${date.slice(0, 7)}/${Date.now()}-${pdfs[0].name.replace(/[^\w.\- ]+/g, "_").slice(-120)}`;
    const up = await admin.storage.from("vault").upload(path, pdfs[0].bytes, { contentType: "application/pdf", upsert: false });
    if (!up.error) file_path = path;
  }
  const sure = !!g.service_id && g.amount != null && g.confidence >= 0.6;
  const key = `email:${g.service_id || "unknown"}:${g.invoice_no || (await sha(new TextEncoder().encode(`${mail.from}|${mail.subject}|${g.amount}|${date}`))).slice(0, 24)}`;
  const row = { tenant_id: tenant, service_id: g.service_id, invoice_no: g.invoice_no, invoice_date: date, period_month: date.slice(0, 8) + "01",
    amount: g.amount ?? 0, currency: g.currency, status: sure ? g.status : "review", source: "email", external_key: key, file_path,
    from_address: mail.from.slice(0, 300), subject: mail.subject.slice(0, 500), confidence: g.confidence,
    note: sure ? null : !g.service_id ? "Couldn't tell which service this is from. Pick the service and confirm." : g.amount == null ? "No amount found. Enter it and confirm." : "Please check the figures and confirm." };
  const { error } = await admin.from("platform_invoices").upsert(row, { onConflict: "tenant_id,external_key", ignoreDuplicates: true });
  const detail = error ? `Platform invoice not saved: ${error.message}` : `Platform invoice: ${g.service_name || "unknown service"} ${g.amount ?? "?"} ${g.currency}${sure ? "" : " (needs review)"}`;
  await admin.from("inbound_emails").insert({ tenant_id: tenant, hotel_id: null, to_address: mail.to.join(", ").slice(0, 500), from_address: mail.from.slice(0, 300),
    subject: mail.subject.slice(0, 500), attachments: mail.atts.length, status: error ? "failed" : "processed", detail, message_id: mail.messageId });
  return { ok: !error, platform_invoice: true, service: g.service_name, amount: g.amount, review: !sure };
}

// content types are taken from the file extension, never from the sender
const TYPES: Record<string, string> = { pdf: "application/pdf", csv: "text/csv", tsv: "text/tab-separated-values", txt: "text/plain", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", xls: "application/vnd.ms-excel", xml: "application/xml", prn: "text/plain", rpt: "text/plain" };
const typeOf = (name: string) => TYPES[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method !== "POST") return ok({ ok: true, hint: "POST inbound email here" });
  const { data: cfg } = await admin.from("app_config").select("value").eq("key", "inbound_token").maybeSingle();
  const expected = env("INBOUND_TOKEN") || cfg?.value || "";
  if (!sameText(req.headers.get("x-akea-token") || url.searchParams.get("token") || "", expected)) return ok({ error: "Not allowed" }, 401);
  let mail: Mail;
  try { mail = await readMail(req); } catch (e) { return ok({ error: "Couldn't read the message" }, 400); }
  // a provider retry of a message already handled is acknowledged and skipped
  if (mail.messageId) {
    const { data: seenMsg } = await admin.from("inbound_emails").select("id").eq("message_id", mail.messageId).maybeSingle();
    if (seenMsg) return ok({ ok: true, duplicate: true });
  }
  // software invoices sent to a company's billing address go to Platform costs, not to a hotel
  const { data: billing } = await admin.from("platform_cost_settings").select("tenant_id,billing_email").not("billing_email", "is", null);
  const bill = (billing || []).find((b: any) => mail.to.includes(String(b.billing_email).toLowerCase()));
  if (bill) return ok(await platformInvoice(bill.tenant_id, String(bill.billing_email), mail));

  // which company: its report inbox (reports@akeahms.com) — or, for older setups, a hotel's own address
  const { data: tenants } = await admin.from("tenants").select("id,report_inbox,report_senders").not("report_inbox", "is", null);
  const company = (tenants || []).find((t: any) => mail.to.includes(String(t.report_inbox).toLowerCase()));
  const { data: direct } = await admin.from("hotels").select("id,tenant_id").in("report_email", mail.to.length ? mail.to : ["-"]);
  const tenantId: string | null = company?.id || (direct?.length === 1 ? direct[0].tenant_id : null);
  const baseLog = { to_address: mail.to.join(", ").slice(0, 500), from_address: mail.from.slice(0, 300), subject: mail.subject.slice(0, 500), attachments: mail.atts.length, message_id: mail.messageId };
  if (!tenantId) {
    await admin.from("inbound_emails").insert({ ...baseLog, status: "unmatched", detail: "Not sent to a report inbox" });
    return ok({ ok: true, matched: false }); // 200 so the provider doesn't retry forever
  }
  const allowed: string[] = company?.report_senders || (tenants || []).find((t: any) => t.id === tenantId)?.report_senders || [];
  if (!senderAllowed(mail.from, allowed)) {
    await admin.from("inbound_emails").insert({ ...baseLog, tenant_id: tenantId, status: "unmatched", detail: `Sender ${mail.from} isn't on the allowed list for reports` });
    return ok({ ok: true, matched: false });
  }

  // a report pasted in the email body (no attachment) is read too
  const items: Att[] = mail.atts.length ? mail.atts : mail.text.trim().length > 200 ? [{ name: "email-body.txt", type: "text/plain", bytes: new TextEncoder().encode(mail.text) }] : [];
  // read every file once (used for both hotel matching and the numbers)
  const read: { a: Att; hash: string; text: string; err: string | null }[] = [];
  const seen = new Set<string>();
  const notes: string[] = [...mail.skipped];
  for (const a of items) {
    const hash = await sha(a.bytes);
    if (seen.has(hash)) { notes.push(`${a.name}: duplicate attachment skipped`); continue; }
    seen.add(hash);
    let text = "", err: string | null = null;
    try {
      text = await Promise.race([textOf(a), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("took too long to read")), 20_000))]);
    } catch (e) { err = (e as Error).message; }
    read.push({ a, hash, text, err });
  }

  const { data: hotelsOfCompany } = await admin.from("hotels").select("id,tenant_id,name,city,rooms,timezone,report_email,property_code").eq("tenant_id", tenantId);
  let hotel: any = (hotelsOfCompany || []).find((h: any) => h.report_email && mail.to.includes(String(h.report_email).toLowerCase())) || null;
  let how = hotel ? "hotel's own address" : "";
  if (!hotel) {
    const codes = read.map((r) => (r.text ? extractReport(r.text, 0).extra?.property_code : undefined)).filter((c): c is string => !!c);
    const m = matchHotel(hotelsOfCompany || [], mail.subject, read.map((r) => r.a.name), codes);
    hotel = m.hotel; how = m.how;
  }
  if (!hotel) {
    await admin.from("inbound_emails").insert({ ...baseLog, tenant_id: tenantId, status: "unmatched",
      detail: `Couldn't tell which hotel this is for (${how}). Put the hotel's property code or name in the subject, or upload it in the Report Inbox.` });
    return ok({ ok: true, matched: false });
  }
  notes.unshift(`hotel from ${how}`);

  let created = 0, failed = 0;
  let snapshotDate: string | null = null;
  const tz = hotel.timezone || "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  for (const { a, hash, text, err } of read) {
    try {
      if (err) throw new Error(err);
      let date = businessDate(mail.subject, a.name, tz);
      let type = guessType(a.name, mail.subject);
      const g = text.trim() ? extractReport(text, hotel.rooms) : null;
      if (g?.extra?.format) { type = "final_audit"; if (g.business_date) date = g.business_date; }
      const { data: dup } = await admin.from("reports").select("id").eq("hotel_id", hotel.id).eq("sha256", hash).maybeSingle();
      if (dup) { notes.push(`${a.name}: already received`); continue; }
      const safe = a.name.replace(/[^\w.\- ]+/g, "_").slice(-150);
      const path = `${hotel.tenant_id}/${hotel.id}/${date}/${Date.now()}-${safe}`;
      const up = await admin.storage.from("reports").upload(path, a.bytes, { contentType: typeOf(a.name), upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data: rep, error } = await admin.from("reports").insert({ tenant_id: hotel.tenant_id, hotel_id: hotel.id, report_type: type, business_date: date, file_name: a.name.slice(0, 200),
        file_path: path, file_format: (a.name.split(".").pop() || "").toUpperCase().slice(0, 10), source: "email", status: "received", sha256: hash }).select("id").single();
      if (error) { await admin.storage.from("reports").remove([path]); throw new Error(error.message); }
      created++;
      // only a recognised night-audit layout (or a file clearly named as one, read with high confidence) for a recent date updates the day's numbers
      const found = g ? Object.keys(g.values).filter((k) => k !== "rooms_available").length : 0;
      const recent = dateInWindow(date, today);
      if (g && found && recent && (g.extra?.format || (type === "final_audit" && g.confidence >= 0.9))) {
        await admin.from("reports").update({ extracted: { values: g.values, deposits: g.deposits, business_date_in_file: g.business_date, extra: g.extra || null }, extracted_notes: g.notes }).eq("id", rep.id);
        const r = await admin.rpc("ingest_report_system_v2", { p_report: rep.id, p_values: g.values, p_confidence: g.confidence, p_deposits: Object.keys(g.deposits).length ? g.deposits : null, p_extra: g.extra || null });
        notes.push(`${a.name}: ${r.error ? "numbers not saved" : r.data} (${found} figures${g.extra?.format ? ", " + g.extra.format : ""})`);
        if (r.error) console.error("ingest:", r.error.message);
        if (!r.error) snapshotDate = date;
      } else {
        await admin.from("reports").update({ status: "processed" }).eq("id", rep.id);
        notes.push(`${a.name}: stored as ${type.replace(/_/g, " ")}${g && found && !recent ? ` (date ${date} is outside the last 60 days, so the numbers weren't applied)` : ""}`);
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
  await admin.from("inbound_emails").insert({ ...baseLog, tenant_id: hotel.tenant_id, hotel_id: hotel.id, reports_created: created,
    status: !read.length ? "failed" : failed ? (created ? "partial" : "failed") : "processed",
    detail: read.length ? notes.join("; ").slice(0, 2000) : "No attachments or report text in the email" });
  return ok({ ok: true, hotel: hotel.name, created });
});
