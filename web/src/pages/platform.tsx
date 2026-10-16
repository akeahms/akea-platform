// Platform costs: what the software costs to build and run, from real invoices.
// Invoices arrive by API (Anthropic cost report), by email (forward receipts to the billing address) or by hand.
import React, { useMemo, useState } from "react";
import { db, storage, callFunction } from "../lib/sb";
import { Ctx, fmtDate } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, Notice, Tabs, Kpi, downloadFile, toCsv } from "../ui";
import { documentText } from "../lib/parse";
import { extractInvoice } from "../lib/extract";

type Service = { id: string; name: string; category: string; purpose: string | null; plan: string | null; billing_cycle: string; expected_amount: number | null;
  phase: string; feed: "api" | "email" | "manual"; match_terms: string[]; website: string | null; started_on: string | null; active: boolean; notes: string | null };
type Invoice = { id: string; service_id: string | null; invoice_no: string | null; invoice_date: string; period_month: string; amount: number; currency: string;
  status: "paid" | "due" | "accruing" | "review"; source: string; external_key: string; file_path: string | null; from_address: string | null; subject: string | null; note: string | null };

const CYCLE: Record<string, string> = { monthly: "Monthly", annual: "Yearly", usage: "By usage", one_time: "One-time", free: "Free" };
const FEED: Record<string, [string, "good" | "info" | "mute"]> = { api: ["Auto · API", "good"], email: ["Auto · email", "info"], manual: ["Manual", "mute"] };
const STATUS: Record<string, [string, "good" | "warn" | "bad" | "info"]> = { paid: ["Paid", "good"], due: ["Due", "warn"], accruing: ["Month to date", "info"], review: ["Needs review", "bad"] };
const CATS = ["Database", "Hosting", "AI", "Build tools", "Bank feeds", "Accounting", "Email", "Mobile", "Domain", "Code", "Other"];
const money = (v: number, cur = "USD") => {
  const sym: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", CAD: "CA$" };
  return `${v < 0 ? "-" : ""}${sym[cur] ?? cur + " "}${Math.abs(v).toLocaleString(cur === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
/** Totals per currency, US dollars first: "$1,234.00 + ₹8,700.00". */
function sumText(rows: Invoice[]) {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) || 0) + Number(r.amount));
  if (!by.size) return money(0);
  return [...by.entries()].sort((a, b) => (a[0] === "USD" ? -1 : b[0] === "USD" ? 1 : a[0].localeCompare(b[0]))).map(([c, v]) => money(v, c)).join(" + ");
}
const monthStart = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
const addMonths = (m: string, n: number) => { const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1); return monthStart(d); };
const monthLabel = (m: string) => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

export function PlatformCosts({ ctx }: { ctx: Ctx }) {
  const t = ctx.tenant.id;
  const canEdit = ctx.can("platform_costs", "edit");
  const [tab, setTab] = useState<"overview" | "invoices" | "setup">("overview");
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const q = useAsync(async () => {
    const [services, invoices, settings] = await Promise.all([
      db.get<Service>(`platform_services?select=*&tenant_id=eq.${t}&order=category.asc,name.asc`),
      db.get<Invoice>(`platform_invoices?select=*&tenant_id=eq.${t}&order=invoice_date.desc&limit=5000`),
      db.get<any>(`platform_cost_settings?select=*&tenant_id=eq.${t}`),
    ]);
    return { services, invoices, settings: settings[0] || null };
  }, [t]);
  const usage = useAsync(() => db.rpc<Record<string, number>>("platform_usage", { p_tenant: t, p_month: monthStart() }), [t]);
  const fn = useAsync(() => callFunction<{ anthropic: boolean }>("platform-costs", { action: "status", tenant_id: t }).catch(() => ({ anthropic: false })), [t]);
  const [editSvc, setEditSvc] = useState<Partial<Service> | null>(null);
  const [editInv, setEditInv] = useState<Partial<Invoice> & { file?: File | null } | null>(null);
  const [svcFilter, setSvcFilter] = useState("");
  const [busy, setBusy] = useState("");

  const d = q.data;
  const svcName = (id: string | null) => d?.services.find((s) => s.id === id)?.name || "Unassigned";
  const counted = (d?.invoices || []).filter((i) => i.status !== "review");
  const thisM = monthStart(), lastM = addMonths(thisM, -1), yearStart = `${thisM.slice(0, 4)}-01-01`;
  const inMonth = (m: string) => counted.filter((i) => i.period_month === m);
  const runRateUsd = (() => {
    const ms = [1, 2, 3].map((n) => addMonths(thisM, -n));
    const tot = ms.map((m) => inMonth(m).filter((i) => i.currency === "USD").reduce((a, i) => a + Number(i.amount), 0));
    const withData = tot.filter((x) => x > 0);
    return withData.length ? withData.reduce((a, b) => a + b, 0) / withData.length : null;
  })();
  const review = (d?.invoices || []).filter((i) => i.status === "review");
  const firstMonth = counted.length ? counted.reduce((a, i) => (i.period_month < a ? i.period_month : a), counted[0].period_month) : null;
  const perService = useMemo(() => {
    const m = new Map<string, { last?: Invoice; ytd: Invoice[]; all: Invoice[] }>();
    for (const i of counted) {
      const k = i.service_id || "";
      const e = m.get(k) || { ytd: [], all: [] };
      if (!e.last || i.invoice_date > e.last.invoice_date) e.last = i;
      if (i.period_month >= yearStart) e.ytd.push(i);
      e.all.push(i);
      m.set(k, e);
    }
    return m;
  }, [d]);

  async function run(label: string, f: () => Promise<string>) {
    setBusy(label); setMsg(null);
    try { setMsg({ kind: "good", text: await f() }); q.reload(); } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(""); }
  }
  const syncAnthropic = () => run("anthropic", async () => {
    const r = await callFunction<any>("platform-costs", { action: "sync", tenant_id: t });
    return r.note || `Anthropic costs updated (${r.months} month${r.months === 1 ? "" : "s"}).`;
  });
  async function openFile(p: string) {
    try { window.open(await storage.signedUrl("vault", p, 120), "_blank", "noopener"); } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  function exportCsv() {
    const rows: (string | number | null)[][] = [["Service", "Category", "Invoice #", "Invoice date", "Month", "Amount", "Currency", "Status", "Source"]];
    for (const i of d?.invoices || []) rows.push([svcName(i.service_id), d?.services.find((s) => s.id === i.service_id)?.category || "", i.invoice_no, i.invoice_date, i.period_month.slice(0, 7), Number(i.amount), i.currency, STATUS[i.status][0], i.source]);
    downloadFile(`platform-costs-${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + toCsv(rows));
  }

  async function saveInvoice(e: React.FormEvent) {
    e.preventDefault();
    const f = editInv!;
    await run("inv", async () => {
      let file_path = f.file_path || null;
      if (f.file) {
        file_path = `${t}/platform-costs/${String(f.invoice_date).slice(0, 7)}/${Date.now()}-${f.file.name.replace(/[^\w.\- ]+/g, "_").slice(-120)}`;
        await storage.upload("vault", file_path, f.file);
      }
      const row = { tenant_id: t, service_id: f.service_id || null, invoice_no: f.invoice_no || null, invoice_date: f.invoice_date, period_month: String(f.invoice_date).slice(0, 8) + "01",
        amount: Number(f.amount), currency: f.currency || "USD", status: f.status === "review" ? "paid" : f.status || "paid", file_path, note: f.note || null, updated_at: new Date().toISOString() };
      if (f.id) await db.update("platform_invoices", `id=eq.${f.id}`, row, "id");
      else await db.insert("platform_invoices", { ...row, source: f.file ? "upload" : "manual", external_key: `manual:${crypto.randomUUID()}` }, "id");
      setEditInv(null);
      return f.id ? "Invoice saved." : "Invoice added.";
    });
  }
  async function readPdf(file: File) {
    setEditInv((x) => ({ ...x!, file }));
    try {
      const { text } = await documentText(file);
      const g = extractInvoice(text, (d?.services || []).map((s) => ({ id: s.id, name: s.name })));
      setEditInv((x) => ({ ...x!, file, service_id: x!.service_id || g.vendor_id || "", invoice_no: x!.invoice_no || g.invoice_no || "", invoice_date: g.invoice_date || x!.invoice_date,
        amount: x!.amount || (g.amount != null ? g.amount : (x!.amount as any)) }));
    } catch { /* keep manual entry */ }
  }
  async function saveService(e: React.FormEvent) {
    e.preventDefault();
    const s = editSvc!;
    await run("svc", async () => {
      const row = { tenant_id: t, name: s.name, category: s.category || "Other", purpose: s.purpose || null, plan: s.plan || null, billing_cycle: s.billing_cycle || "monthly",
        expected_amount: s.expected_amount === null || (s.expected_amount as any) === "" || s.expected_amount === undefined ? null : Number(s.expected_amount),
        phase: s.phase || "run", feed: s.feed || "email", match_terms: (Array.isArray(s.match_terms) ? s.match_terms : String(s.match_terms || "").split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean),
        website: s.website || null, started_on: s.started_on || null, active: s.active !== false, notes: s.notes || null };
      if (s.id) await db.update("platform_services", `id=eq.${s.id}`, row, "id"); else await db.insert("platform_services", row, "id");
      setEditSvc(null);
      return "Service saved.";
    });
  }

  if (q.error) return <ErrorBox error={q.error} />;
  const billing = d?.settings?.billing_email as string | undefined;
  const invList = (d?.invoices || []).filter((i) => !svcFilter || (svcFilter === "review" ? i.status === "review" : i.service_id === svcFilter));
  return (
    <>
      <PageHead eyebrow="Setup" title="Platform costs" desc="What the platform costs to build and run: hosting, database, AI, bank feeds, email and app stores, from the actual invoices."
        actions={<><button className="btn" onClick={exportCsv} disabled={!d?.invoices.length}>Export</button>{canEdit && <button className="btn pri" onClick={() => setEditInv({ invoice_date: new Date().toISOString().slice(0, 10), currency: "USD", status: "paid", service_id: "" })}>Add invoice</button>}</>} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {!!review.length && <Notice kind="info">{review.length} forwarded invoice{review.length === 1 ? " needs" : "s need"} a quick check (service or amount wasn't clear). <button className="link" onClick={() => { setTab("invoices"); setSvcFilter("review"); }}>Review now</button></Notice>}
      {!d ? <Loading /> : (
        <>
          <div className="kpis">
            <Kpi label={`This month · ${monthLabel(thisM)}`} value={sumText(inMonth(thisM))} />
            <Kpi label="Last month" value={sumText(inMonth(lastM))} />
            <Kpi label="Monthly run-rate (USD)" value={runRateUsd != null ? money(runRateUsd) : "—"} delta={<span className="small muted">average of the last 3 billed months</span>} />
            <Kpi label={`This year · ${thisM.slice(0, 4)}`} value={sumText(counted.filter((i) => i.period_month >= yearStart))} />
            <Kpi label="Total to date (build + run)" value={sumText(counted)} delta={firstMonth ? <span className="small muted">since {monthLabel(firstMonth)}</span> : undefined} />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[["overview", "Services"], ["invoices", `Invoices${review.length ? ` (${review.length} to review)` : ""}`], ["setup", "Automatic invoices"]]} />
          {tab === "overview" && (
            <Card flush title="Services" actions={canEdit ? <button className="btn sm" onClick={() => setEditSvc({ billing_cycle: "monthly", feed: "email", phase: "run", category: "Other", match_terms: [] })}>Add service</button> : undefined}
              note="Expected is your own figure for planning; everything else comes from invoices.">
              <div className="tw"><table>
                <thead><tr><th>Service</th><th>Used for</th><th>Billing</th><th>Invoices</th><th>Last invoice</th><th className="num">Expected</th><th className="num">This year</th><th className="num">To date</th>{canEdit && <th />}</tr></thead>
                <tbody>{d.services.map((s) => {
                  const p = perService.get(s.id);
                  return (
                    <tr key={s.id} className={s.active ? "" : "muted"}>
                      <td><b>{s.name}</b><div className="small muted">{s.category}{s.phase === "build" ? " · build" : s.phase === "both" ? " · build & run" : ""}{s.plan ? ` · ${s.plan}` : ""}</div></td>
                      <td className="small">{s.purpose}</td>
                      <td className="small">{CYCLE[s.billing_cycle]}</td>
                      <td><Pill kind={FEED[s.feed][1]}>{FEED[s.feed][0]}</Pill></td>
                      <td className="small">{p?.last ? <>{fmtDate(p.last.invoice_date)} · {money(Number(p.last.amount), p.last.currency)}</> : <span className="muted">none yet</span>}</td>
                      <td className="num small">{s.expected_amount != null ? money(Number(s.expected_amount)) : ""}</td>
                      <td className="num small">{p?.ytd.length ? sumText(p.ytd) : ""}</td>
                      <td className="num small"><b>{p?.all.length ? sumText(p.all) : ""}</b></td>
                      {canEdit && <td><button className="btn sm" onClick={() => setEditSvc(s)}>Edit</button></td>}
                    </tr>
                  );
                })}</tbody>
              </table></div>
            </Card>
          )}
          {tab === "overview" && usage.data && (
            <Card title={`What the platform used in ${monthLabel(thisM)}`} note="Counts the platform knows itself, to explain usage-based bills.">
              <div className="kpis">
                <Kpi label="Ask AI questions" value={usage.data.ai_questions} />
                <Kpi label="Bank feeds connected" value={usage.data.bank_feeds} />
                <Kpi label="Hotels on QuickBooks" value={usage.data.quickbooks_hotels} />
                <Kpi label="Report emails received" value={usage.data.emails_received} />
                <Kpi label="Hotels · users" value={`${usage.data.hotels} · ${usage.data.users}`} />
              </div>
            </Card>
          )}
          {tab === "invoices" && (
            <Card flush title="Invoices" actions={<select aria-label="Show invoices for" value={svcFilter} onChange={(e) => setSvcFilter(e.target.value)}>
              <option value="">All services</option><option value="review">Needs review</option>{d.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}>
              {!invList.length ? <Empty title="No invoices yet.">Forward receipts to the billing address (see Automatic invoices) or add one by hand.</Empty> : (
                <div className="tw"><table>
                  <thead><tr><th>Date</th><th>Service</th><th>Invoice #</th><th className="num">Amount</th><th>Status</th><th>From</th><th /></tr></thead>
                  <tbody>{invList.map((i) => (
                    <tr key={i.id}>
                      <td className="nowrap small">{fmtDate(i.invoice_date)}</td>
                      <td>{svcName(i.service_id)}{i.note && <div className="small muted">{i.note}</div>}</td>
                      <td className="small">{i.invoice_no}</td>
                      <td className="num"><b>{money(Number(i.amount), i.currency)}</b></td>
                      <td><Pill kind={STATUS[i.status][1]}>{STATUS[i.status][0]}</Pill></td>
                      <td className="small muted">{i.source === "api" ? "Provider API" : i.source === "email" ? `Email${i.from_address ? " · " + i.from_address : ""}` : i.source === "upload" ? "Uploaded" : "Entered"}</td>
                      <td className="nowrap">
                        {i.file_path && <button className="btn sm" onClick={() => openFile(i.file_path!)}>PDF</button>}{" "}
                        {canEdit && i.source !== "api" && <button className="btn sm" onClick={() => setEditInv({ ...i, service_id: i.service_id || "" })}>{i.status === "review" ? "Review" : "Edit"}</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}
          {tab === "setup" && (
            <div className="grid g2">
              <Card title="Forward invoice emails">
                {billing ? <>
                  <p>Send every software receipt or invoice to <b>{billing}</b>. Each one is read automatically: which service, amount, invoice number, date, and the PDF is kept.</p>
                  <button className="btn sm" onClick={() => navigator.clipboard?.writeText(billing).then(() => setMsg({ kind: "good", text: "Billing address copied." }))}>Copy address</button>
                  <ul className="small" style={{ marginTop: 12 }}>
                    <li><b>Best:</b> set it as the billing or invoice email in each provider (Supabase, Render, Postmark, GitHub, Expo, Plaid, Finicity).</li>
                    <li><b>Or:</b> in Gmail, add a filter for receipts from those senders and forward them to this address automatically.</li>
                    <li>Anything unclear lands in <b>Needs review</b>, so nothing is counted until you confirm it.</li>
                  </ul>
                  <p className="small muted">Mail to this address is read by the same inbound email service as the night-audit reports (Postmark). Set the mailbox to forward everything to the Postmark inbound address; it works once that service is switched on.</p>
                </> : <p className="muted">No billing address is set up for this company yet.</p>}
              </Card>
              <Card title="Anthropic (Ask AI) · pulled automatically">
                <p>Ask AI's cost is read every morning from Anthropic's cost report: last month and this month to date.</p>
                {fn.data?.anthropic
                  ? <p><Pill kind="good">Connected</Pill>{d.settings?.anthropic_last_sync && <span className="small muted"> · last updated {new Date(d.settings.anthropic_last_sync).toLocaleString()}</span>}</p>
                  : <p><Pill kind="warn">Not connected</Pill> <span className="small">Create an <b>Admin API key</b> in the Anthropic Console (Settings → Admin keys) and add it as <code>ANTHROPIC_ADMIN_KEY</code> in Supabase → Edge Functions → Secrets.</span></p>}
                {d.settings?.anthropic_last_error && <Notice kind="bad">{d.settings.anthropic_last_error}</Notice>}
                {canEdit && <button className="btn" disabled={!!busy || !fn.data?.anthropic} onClick={syncAnthropic}>{busy === "anthropic" ? "Updating…" : "Update now"}</button>}
              </Card>
              <Card title="Why not every provider is automatic">
                <p className="small">Supabase, Render, Postmark, Plaid, Finicity, Apple and Google don't offer an API for invoices, so forwarded emails are the automatic route for them. Anthropic does, so it's pulled directly. Intuit's QuickBooks developer access is free.</p>
              </Card>
            </div>
          )}
        </>
      )}
      {editInv && (
        <Modal title={editInv.id ? (editInv.status === "review" ? "Review invoice" : "Edit invoice") : "Add invoice"} onClose={() => setEditInv(null)} onSubmit={saveInvoice}
          footer={<>{editInv.id && canEdit && <button type="button" className="btn danger" onClick={() => run("del", async () => { await db.remove("platform_invoices", `id=eq.${editInv.id}`); setEditInv(null); return "Invoice removed."; })}>Remove</button>}
            <span className="grow" /><button type="button" className="btn" onClick={() => setEditInv(null)}>Cancel</button><button className="btn pri" disabled={!!busy}>{editInv.status === "review" ? "Confirm" : "Save"}</button></>}>
          {editInv.subject && <p className="small muted">Email: “{editInv.subject}”{editInv.from_address ? ` from ${editInv.from_address}` : ""}</p>}
          <div className="fgrid">
            <Field label="Service" id="piS"><select id="piS" required value={editInv.service_id || ""} onChange={(e) => setEditInv({ ...editInv, service_id: e.target.value })}>
              <option value="">Choose…</option>{d?.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Invoice date" id="piD"><input id="piD" type="date" required value={editInv.invoice_date || ""} onChange={(e) => setEditInv({ ...editInv, invoice_date: e.target.value })} /></Field>
            <Field label="Amount" id="piA"><input id="piA" type="number" step="0.01" min="0" required value={(editInv.amount as any) ?? ""} onChange={(e) => setEditInv({ ...editInv, amount: e.target.value as any })} /></Field>
            <Field label="Currency" id="piC"><select id="piC" value={editInv.currency || "USD"} onChange={(e) => setEditInv({ ...editInv, currency: e.target.value })}>{["USD", "INR", "EUR", "GBP", "CAD"].map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Invoice #" id="piN"><input id="piN" value={editInv.invoice_no || ""} onChange={(e) => setEditInv({ ...editInv, invoice_no: e.target.value })} /></Field>
            <Field label="Status" id="piSt"><select id="piSt" value={editInv.status === "review" ? "paid" : editInv.status || "paid"} onChange={(e) => setEditInv({ ...editInv, status: e.target.value as any })}><option value="paid">Paid</option><option value="due">Due</option></select></Field>
            {!editInv.file_path && <Field label="Invoice PDF (optional)" id="piF" span hint="The amount, number and date are read from the PDF when possible.">
              <input id="piF" type="file" accept="application/pdf,.pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) readPdf(f); }} /></Field>}
          </div>
        </Modal>
      )}
      {editSvc && (
        <Modal title={editSvc.id ? `Edit ${editSvc.name}` : "Add service"} onClose={() => setEditSvc(null)} onSubmit={saveService} wide
          footer={<><button type="button" className="btn" onClick={() => setEditSvc(null)}>Cancel</button><button className="btn pri" disabled={!!busy}>Save</button></>}>
          <div className="fgrid">
            <Field label="Name" id="psN"><input id="psN" required value={editSvc.name || ""} onChange={(e) => setEditSvc({ ...editSvc, name: e.target.value })} /></Field>
            <Field label="Category" id="psC"><select id="psC" value={editSvc.category || "Other"} onChange={(e) => setEditSvc({ ...editSvc, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Used for" id="psP" span><input id="psP" value={editSvc.purpose || ""} onChange={(e) => setEditSvc({ ...editSvc, purpose: e.target.value })} /></Field>
            <Field label="Plan" id="psPl"><input id="psPl" value={editSvc.plan || ""} onChange={(e) => setEditSvc({ ...editSvc, plan: e.target.value })} placeholder="e.g. Pro" /></Field>
            <Field label="Billing" id="psB"><select id="psB" value={editSvc.billing_cycle || "monthly"} onChange={(e) => setEditSvc({ ...editSvc, billing_cycle: e.target.value })}>{Object.entries(CYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Expected per cycle (USD)" id="psE" hint="Your planning figure"><input id="psE" type="number" step="0.01" min="0" value={(editSvc.expected_amount as any) ?? ""} onChange={(e) => setEditSvc({ ...editSvc, expected_amount: e.target.value as any })} /></Field>
            <Field label="Stage" id="psPh"><select id="psPh" value={editSvc.phase || "run"} onChange={(e) => setEditSvc({ ...editSvc, phase: e.target.value })}><option value="build">Building</option><option value="run">Running</option><option value="both">Both</option></select></Field>
            <Field label="Invoices arrive by" id="psF"><select id="psF" value={editSvc.feed || "email"} onChange={(e) => setEditSvc({ ...editSvc, feed: e.target.value as any })}><option value="email">Forwarded email</option><option value="api">Provider API</option><option value="manual">Entered by hand</option></select></Field>
            <Field label="Started" id="psSt"><input id="psSt" type="date" value={editSvc.started_on || ""} onChange={(e) => setEditSvc({ ...editSvc, started_on: e.target.value })} /></Field>
            <Field label="Recognise emails by" id="psM" span hint="Sender domains or words, comma-separated (e.g. render.com, render services)">
              <input id="psM" value={Array.isArray(editSvc.match_terms) ? editSvc.match_terms.join(", ") : (editSvc.match_terms as any) || ""} onChange={(e) => setEditSvc({ ...editSvc, match_terms: e.target.value as any })} /></Field>
            <Field label="Billing page" id="psW" span><input id="psW" type="url" value={editSvc.website || ""} onChange={(e) => setEditSvc({ ...editSvc, website: e.target.value })} /></Field>
            <Field label="Active" id="psA"><select id="psA" value={editSvc.active === false ? "no" : "yes"} onChange={(e) => setEditSvc({ ...editSvc, active: e.target.value === "yes" })}><option value="yes">Active</option><option value="no">Cancelled</option></select></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
