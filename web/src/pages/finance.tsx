import React, { useMemo, useRef, useState } from "react";
import { db, storage, callFunction } from "../lib/sb";
import { Ctx, usd, fmtDate, todayIn, addDays, periodRange, Period, yesterday, pct } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, HotelSelect, Notice, SampleBadge, Seg, Tabs, downloadFile, toCsv, Kpi } from "../ui";
import { readBankStatement, documentText, BankParse } from "../lib/parse";
import { extractInvoice } from "../lib/extract";

type Gl = { id: string; number: string; name: string; type: string; section: string | null; active: boolean };
type Vendor = { id: string; name: string; dba: string | null; category: string | null; contact_name: string | null; email: string | null; phone: string | null; address: string | null;
  payment_terms: string | null; default_gl: string | null; remit_method: string; w9_on_file: boolean; tax_id_last4: string | null; is_1099: boolean; status: string; notes: string | null; data_source: string };
type Bill = { id: string; hotel_id: string; vendor_id: string | null; po_id: string | null; invoice_no: string | null; invoice_date: string | null; due_date: string | null; amount: number;
  gl_account_id: string | null; description: string | null; status: string; file_path: string | null; approved_at: string | null; paid_at: string | null; scheduled_for: string | null;
  payment_method: string | null; payment_ref: string | null; decision_note: string | null; data_source: string; source: string };
type BankAcct = { id: string; hotel_id: string; name: string; institution: string | null; last4: string | null; kind: string; feed: string; balance: number | null; balance_as_of: string | null; last_synced_at: string | null; data_source: string };

const BILL_STATUS: Record<string, [string, "good" | "warn" | "bad" | "info" | "mute"]> = {
  draft: ["Draft", "mute"], pending_approval: ["Waiting for approval", "warn"], approved: ["Approved · to pay", "info"], scheduled: ["Payment scheduled", "info"],
  paid: ["Paid", "good"], rejected: ["Rejected", "bad"], void: ["Void", "mute"],
};
const sanitize = (n: string) => n.replace(/[^\w.\- ]+/g, "_");
function useLookups(ctx: Ctx) {
  return useAsync(async () => {
    const [gl, vendors] = await Promise.all([
      db.get<Gl>(`gl_accounts?select=id,number,name,type,section,active&tenant_id=eq.${ctx.tenant.id}&order=number.asc`),
      db.get<Vendor>(`vendors?select=*&tenant_id=eq.${ctx.tenant.id}&order=name.asc`),
    ]);
    return { gl, vendors };
  }, [ctx.tenant.id]);
}
const glLabel = (g?: Gl) => (g ? `${g.number} · ${g.name}` : "—");
async function openFile(path: string) {
  const url = await storage.signedUrl("vault", path, 120);
  window.open(url, "_blank", "noopener");
}

// ======================= Bills & bill pay =======================
export function Bills({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState("");
  const [tab, setTab] = useState<"approve" | "pay" | "scheduled" | "paid" | "draft" | "all">("approve");
  const canEdit = ctx.can("finance", "edit"), canApprove = ctx.can("finance", "approve");
  const lk = useLookups(ctx);
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [deciding, setDeciding] = useState<{ bill: Bill; approve: boolean } | null>(null);
  const statusFilter = { approve: "status=eq.pending_approval", pay: "status=eq.approved", scheduled: "status=eq.scheduled", paid: "status=eq.paid", draft: "status=in.(draft,rejected)", all: "" }[tab];
  const q = useAsync(() => db.get<Bill>(`bills?select=*&tenant_id=eq.${ctx.tenant.id}${hotelId ? `&hotel_id=eq.${hotelId}` : ""}${statusFilter ? "&" + statusFilter : ""}&order=due_date.asc.nullslast&limit=300`), [hotelId, tab]);
  const counts = useAsync(() => db.get<any>(`bills?select=status,amount&tenant_id=eq.${ctx.tenant.id}${hotelId ? `&hotel_id=eq.${hotelId}` : ""}&status=in.(pending_approval,approved,scheduled)`), [hotelId, q.data]);
  const vName = (id: string | null) => lk.data?.vendors.find((v) => v.id === id)?.name || "—";
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";
  const today = todayIn();
  const sum = (s: string) => (counts.data || []).filter((b: any) => b.status === s).reduce((a: number, b: any) => a + Number(b.amount), 0);
  const n = (s: string) => (counts.data || []).filter((b: any) => b.status === s).length;
  const rows = q.data || [];
  const selected = rows.filter((b) => sel.includes(b.id));

  async function submit(b: Bill) {
    try { await db.update("bills", `id=eq.${b.id}`, { status: "pending_approval" }, "id"); setMsg({ kind: "good", text: "Sent for approval." }); q.reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  return (
    <>
      <PageHead eyebrow="Finance" title="Bills & Bill Pay" desc="Invoices in, approvals by limit, payments out — every step recorded and posted to the ledger."
        actions={<>
          <button className="btn" onClick={() => downloadFile(`bills_${tab}.csv`, toCsv([["Vendor", "Hotel", "Invoice", "Invoice date", "Due", "Amount", "Status"], ...rows.map((b) => [vName(b.vendor_id), hName(b.hotel_id), b.invoice_no, b.invoice_date, b.due_date, b.amount, b.status])]))}>Export</button>
          {canEdit && <button className="btn pri" onClick={() => setAdding(true)}>Add bill</button>}
        </>} />
      <div className="stat-row">
        <Kpi label="Waiting for approval" value={usd(sum("pending_approval"))} delta={<span className="tag">{n("pending_approval")} bills</span>} />
        <Kpi label="Approved, to pay" value={usd(sum("approved"))} delta={<span className="tag">{n("approved")} bills</span>} />
        <Kpi label="Scheduled" value={usd(sum("scheduled"))} delta={<span className="tag">{n("scheduled")} bills</span>} />
      </div>
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={(v) => { setHotelId(v); setSel([]); }} all />
        <span className="grow" />
        {tab === "pay" && canApprove && <button className="btn pri" disabled={!selected.length} onClick={() => setPaying(true)}>Pay {selected.length || ""} selected · {usd(selected.reduce((a, b) => a + Number(b.amount), 0), 2)}</button>}
      </div>
      <Tabs value={tab} onChange={(t) => { setTab(t); setSel([]); }} tabs={[["approve", "To approve"], ["pay", "To pay"], ["scheduled", "Scheduled"], ["paid", "Paid"], ["draft", "Drafts & rejected"], ["all", "All"]]} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {(q.loading && !q.data) && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && lk.data && (
        <Card flush>
          {rows.length ? (
            <div className="tw"><table>
              <thead><tr>{tab === "pay" && canApprove && <th><input type="checkbox" aria-label="Select all" checked={sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((b) => b.id) : [])} /></th>}
                <th>Vendor</th>{!hotelId && <th>Hotel</th>}<th>Invoice</th><th>Due</th><th>Account</th><th className="n">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>{rows.map((b) => {
                const overdue = b.due_date && b.due_date < today && !["paid", "void", "rejected"].includes(b.status);
                return (
                  <tr key={b.id} className={sel.includes(b.id) ? "sel" : ""}>
                    {tab === "pay" && canApprove && <td><input type="checkbox" aria-label={`Select ${b.invoice_no}`} checked={sel.includes(b.id)} onChange={(e) => setSel(e.target.checked ? [...sel, b.id] : sel.filter((x) => x !== b.id))} /></td>}
                    <td><b>{vName(b.vendor_id)}</b> <SampleBadge show={b.data_source === "sample"} /><div className="tag">{b.description}</div></td>
                    {!hotelId && <td className="small">{hName(b.hotel_id)}</td>}
                    <td className="nowrap">{b.invoice_no || "—"}<div className="tag">{b.invoice_date ? fmtDate(b.invoice_date) : ""}</div></td>
                    <td className="nowrap">{b.due_date ? fmtDate(b.due_date) : "—"}{overdue && <div><Pill kind="bad">Overdue</Pill></div>}</td>
                    <td className="small">{glLabel(lk.data!.gl.find((g) => g.id === b.gl_account_id))}</td>
                    <td className="n"><b>{usd(Number(b.amount), 2)}</b></td>
                    <td><Pill kind={BILL_STATUS[b.status]?.[1] || "mute"}>{BILL_STATUS[b.status]?.[0] || b.status}</Pill>
                      {b.status === "paid" && <div className="tag">{b.paid_at ? fmtDate(b.paid_at) : ""} · {b.payment_method}</div>}
                      {b.status === "scheduled" && <div className="tag">{b.scheduled_for ? fmtDate(b.scheduled_for) : ""}</div>}
                      {b.decision_note && <div className="tag" title={b.decision_note}>Note: {b.decision_note}</div>}</td>
                    <td><div className="row-actions">
                      {b.file_path && <button className="btn sm" onClick={() => openFile(b.file_path!).catch((e) => setMsg({ kind: "bad", text: e.message }))}>View</button>}
                      {b.status === "draft" && canEdit && <button className="btn sm" onClick={() => submit(b)}>Submit</button>}
                      {b.status === "pending_approval" && canApprove && <>
                        <button className="btn sm" onClick={() => setDeciding({ bill: b, approve: false })}>Reject</button>
                        <button className="btn sm pri" onClick={() => setDeciding({ bill: b, approve: true })}>Approve</button></>}
                    </div></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          ) : <Empty title={tab === "approve" ? "Nothing waiting for approval." : "No bills here."} />}
        </Card>
      )}
      {adding && lk.data && <BillForm ctx={ctx} vendors={lk.data.vendors} gl={lk.data.gl} hotelId={hotelId || operating[0]?.id} onClose={(saved) => { setAdding(false); if (saved) { setMsg({ kind: "good", text: saved }); q.reload(); } }} />}
      {paying && <PayModal ctx={ctx} bills={selected} onClose={(done) => { setPaying(false); if (done) { setSel([]); setMsg({ kind: "good", text: done }); q.reload(); } }} />}
      {deciding && <DecideModal what="bill" name={`${vName(deciding.bill.vendor_id)} · ${usd(Number(deciding.bill.amount), 2)}`} approve={deciding.approve}
        onConfirm={async (note) => { await db.rpc("decide_bill", { p_id: deciding.bill.id, p_approve: deciding.approve, p_note: note || null }); }}
        onClose={(ok) => { setDeciding(null); if (ok) { setMsg({ kind: "good", text: ok }); q.reload(); } }} />}
    </>
  );
}

export function DecideModal({ what, name, approve, onConfirm, onClose }: { what: string; name: string; approve: boolean; onConfirm: (note: string) => Promise<void>; onClose: (ok?: string) => void }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await onConfirm(note); onClose(`${what[0].toUpperCase() + what.slice(1)} ${approve ? "approved" : "rejected"}.`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${approve ? "Approve" : "Reject"} ${what}`} onClose={() => onClose()} onSubmit={go}
      footer={<><button type="button" className="btn" onClick={() => onClose()}>Cancel</button><button className={"btn " + (approve ? "pri" : "")} disabled={busy}>{approve ? "Approve" : "Reject"}</button></>}>
      <p style={{ marginTop: 0 }}><b>{name}</b></p>
      <Field label={approve ? "Note (optional)" : "Reason"} id="decNote"><textarea id="decNote" required={!approve} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {approve && <p className="small muted">Approving posts the expense to the ledger. Your approval limit is checked automatically.</p>}
      {err && <Notice kind="bad">{err}</Notice>}
    </Modal>
  );
}

function BillForm({ ctx, vendors, gl, hotelId, onClose }: { ctx: Ctx; vendors: Vendor[]; gl: Gl[]; hotelId: string; onClose: (saved?: string) => void }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [f, setF] = useState<any>({ hotel_id: hotelId, vendor_id: "", invoice_no: "", invoice_date: todayIn(), due_date: addDays(todayIn(), 30), amount: "", gl_account_id: "", description: "" });
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState<string>("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function pick(fl: File) {
    setFile(fl);
    setReading("Reading invoice…");
    const t0 = performance.now();
    try {
      const { text } = await documentText(fl);
      if (!text.trim()) { setReading("Saved as an image — no text layer to read. Fill in the fields."); return; }
      const g = extractInvoice(text, vendors);
      const v = vendors.find((x) => x.id === g.vendor_id);
      setF((o: any) => ({ ...o, vendor_id: g.vendor_id || o.vendor_id, invoice_no: g.invoice_no || o.invoice_no, invoice_date: g.invoice_date || o.invoice_date,
        due_date: g.due_date || o.due_date, amount: g.amount ?? o.amount, gl_account_id: v?.default_gl || o.gl_account_id }));
      setReading(`Read in ${Math.round(performance.now() - t0)} ms · ${Math.round(g.confidence * 100)}% of key fields found. Check before saving.`);
    } catch (e: any) { setReading(`Couldn't read this file (${e.message}). Fill in the fields.`); }
  }
  async function save(submit: boolean) {
    setBusy(true); setErr("");
    try {
      if (!f.vendor_id) throw new Error("Choose the vendor.");
      if (!(Number(f.amount) > 0)) throw new Error("Enter the amount.");
      let file_path: string | null = null;
      if (file) {
        file_path = `${ctx.tenant.id}/bills/${f.hotel_id}/${Date.now()}-${sanitize(file.name)}`;
        await storage.upload("vault", file_path, file);
      }
      await db.insert("bills", { tenant_id: ctx.tenant.id, hotel_id: f.hotel_id, vendor_id: f.vendor_id, invoice_no: f.invoice_no || null, invoice_date: f.invoice_date || null,
        due_date: f.due_date || null, amount: Number(f.amount), gl_account_id: f.gl_account_id || vendors.find((v) => v.id === f.vendor_id)?.default_gl || null,
        description: f.description || null, status: submit ? "pending_approval" : "draft", file_path, source: file ? "upload" : "manual" }, "id");
      onClose(submit ? "Bill submitted for approval." : "Bill saved as a draft.");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Add bill" onClose={() => onClose()} wide
      footer={<><button className="btn" onClick={() => onClose()}>Cancel</button><button className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button><button className="btn pri" disabled={busy} onClick={() => save(true)}>Submit for approval</button></>}>
      <div className="drop" style={{ marginBottom: 14 }}>
        <b>{file ? file.name : "Upload the invoice (PDF, Excel, image)"}</b>
        <span className="small muted">{reading || "Fields fill in automatically from digital PDFs and spreadsheets."}</span>
        <label className="btn" htmlFor="billFile">{file ? "Replace file" : "Choose file"}</label>
        <input id="billFile" type="file" hidden accept=".pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.heic" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      </div>
      <div className="fgrid">
        <Field label="Hotel" id="bH"><HotelSelect hotels={operating} value={f.hotel_id} onChange={(v) => setF({ ...f, hotel_id: v })} id="bH" /></Field>
        <Field label="Vendor" id="bV">
          <select id="bV" value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value, gl_account_id: vendors.find((v) => v.id === e.target.value)?.default_gl || f.gl_account_id })}>
            <option value="">Choose…</option>{vendors.filter((v) => v.status === "active").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Invoice number" id="bN"><input id="bN" value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></Field>
        <Field label="Amount ($)" id="bA"><input id="bA" type="number" step="0.01" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Invoice date" id="bD"><input id="bD" type="date" value={f.invoice_date || ""} onChange={(e) => setF({ ...f, invoice_date: e.target.value })} /></Field>
        <Field label="Due date" id="bDue"><input id="bDue" type="date" value={f.due_date || ""} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <Field label="Expense account" id="bG">
          <select id="bG" value={f.gl_account_id} onChange={(e) => setF({ ...f, gl_account_id: e.target.value })}>
            <option value="">Vendor default</option>{gl.filter((g) => g.type === "expense" || g.type === "asset").map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}
          </select>
        </Field>
        <Field label="Description" id="bDesc" span><input id="bDesc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      {err && <Notice kind="bad">{err}</Notice>}
    </Modal>
  );
}

function PayModal({ ctx, bills, onClose }: { ctx: Ctx; bills: Bill[]; onClose: (done?: string) => void }) {
  const hotels = [...new Set(bills.map((b) => b.hotel_id))];
  const accts = useAsync(() => db.get<BankAcct>(`bank_accounts?select=*&hotel_id=in.(${hotels.join(",")})`), [hotels.join()]);
  const [f, setF] = useState({ method: "ach", date: todayIn(), ref: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      let total = 0;
      for (const h of hotels) {
        const acct = accts.data?.find((a) => a.hotel_id === h && a.kind === "operating") || accts.data?.find((a) => a.hotel_id === h);
        if (!acct) throw new Error(`${ctx.hotels.find((x) => x.id === h)?.name} has no bank account set up yet (Banking page).`);
        total += await db.rpc<number>("pay_bills", { p_ids: bills.filter((b) => b.hotel_id === h).map((b) => b.id), p_bank: acct.id, p_method: f.method, p_date: f.date, p_ref: f.ref || null });
      }
      onClose(`${total} bill${total === 1 ? "" : "s"} ${f.date > todayIn() ? "scheduled" : "recorded as paid"}. The bank match happens automatically when the payment clears.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Pay ${bills.length} bill${bills.length === 1 ? "" : "s"}`} onClose={() => onClose()} onSubmit={pay}
      footer={<><button type="button" className="btn" onClick={() => onClose()}>Cancel</button><button className="btn pri" disabled={busy || accts.loading}>{f.date > todayIn() ? "Schedule payment" : "Record payment"} · {usd(bills.reduce((a, b) => a + Number(b.amount), 0), 2)}</button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>Each hotel's bills are paid from that hotel's operating account. Future dates schedule the payment.</p>
      <div className="fgrid">
        <Field label="Method" id="pM"><select id="pM" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          <option value="ach">ACH</option><option value="check">Check</option><option value="card">Card</option><option value="wire">Wire</option><option value="autopay">Autopay</option></select></Field>
        <Field label="Payment date" id="pDt"><input id="pDt" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={f.method === "check" ? "Check number" : "Reference (optional)"} id="pRef"><input id="pRef" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
      </div>
      {err && <Notice kind="bad">{err}</Notice>}
    </Modal>
  );
}

// ======================= Vendors =======================
export function Vendors({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("finance", "edit");
  const lk = useLookups(ctx);
  const spend = useAsync(() => db.get<any>(`bills?select=vendor_id,amount,status,invoice_date&tenant_id=eq.${ctx.tenant.id}&invoice_date=gte.${todayIn().slice(0, 4)}-01-01&status=in.(approved,scheduled,paid)`), [ctx.tenant.id]);
  const [edit, setEdit] = useState<Partial<Vendor> | null>(null);
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const ytd = (id: string) => (spend.data || []).filter((b: any) => b.vendor_id === id).reduce((a: number, b: any) => a + Number(b.amount), 0);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    try {
      if (edit.tax_id_last4 && !/^\d{4}$/.test(edit.tax_id_last4)) throw new Error("Tax ID: enter only the last 4 digits.");
      const { id, data_source, ...row } = edit as any;
      if (id) await db.update("vendors", `id=eq.${id}`, row, "id");
      else await db.insert("vendors", { ...row, tenant_id: ctx.tenant.id }, "id");
      setEdit(null); setMsg({ kind: "good", text: "Vendor saved." }); lk.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  const list = (lk.data?.vendors || []).filter((v) => !search || `${v.name} ${v.category}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHead eyebrow="Finance" title="Vendors" desc="Everyone you pay: contacts, terms, default expense account, W-9 and 1099 status."
        actions={<>
          <button className="btn" onClick={() => downloadFile("vendors-1099.csv", toCsv([["Vendor", "1099", "W-9 on file", "Tax ID (last 4)", "Paid YTD"], ...(lk.data?.vendors || []).filter((v) => v.is_1099).map((v) => [v.name, "Yes", v.w9_on_file ? "Yes" : "No", v.tax_id_last4, ytd(v.id).toFixed(2)])]))}>1099 report</button>
          {canEdit && <button className="btn pri" onClick={() => setEdit({ name: "", remit_method: "ach", payment_terms: "Net 30", status: "active", w9_on_file: false, is_1099: false })}>Add vendor</button>}
        </>} />
      <div className="toolbar"><input type="search" aria-label="Search vendors" placeholder="Search vendors" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 260 }} /></div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {lk.loading && !lk.data && <Loading />}
      {lk.error && <ErrorBox error={lk.error} retry={lk.reload} />}
      {lk.data && (
        <Card flush>
          {list.length ? <div className="tw"><table>
            <thead><tr><th>Vendor</th><th>Category</th><th>Contact</th><th>Terms</th><th>Pays by</th><th>Default account</th><th>W-9</th><th>1099</th><th className="n">Spend YTD</th><th></th></tr></thead>
            <tbody>{list.map((v) => (
              <tr key={v.id}>
                <td><b>{v.name}</b> <SampleBadge show={v.data_source === "sample"} />{v.status !== "active" && <div className="tag">inactive</div>}</td>
                <td className="small">{v.category}</td>
                <td className="small">{v.contact_name}<div className="tag">{v.email || v.phone}</div></td>
                <td className="small nowrap">{v.payment_terms}</td>
                <td className="small">{v.remit_method.toUpperCase()}</td>
                <td className="small">{glLabel(lk.data!.gl.find((g) => g.id === v.default_gl))}</td>
                <td>{v.w9_on_file ? <Pill kind="good">On file</Pill> : <Pill kind="warn">Missing</Pill>}</td>
                <td>{v.is_1099 ? <Pill kind="info">1099</Pill> : <span className="muted">—</span>}</td>
                <td className="n">{usd(ytd(v.id))}</td>
                <td>{canEdit && <button className="btn sm" onClick={() => setEdit({ ...v })}>Edit</button>}</td>
              </tr>
            ))}</tbody></table></div> : <Empty title="No vendors found." />}
        </Card>
      )}
      {edit && lk.data && (
        <Modal title={edit.id ? `Edit ${edit.name}` : "Add vendor"} onClose={() => setEdit(null)} onSubmit={save} wide
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri">Save vendor</button></>}>
          <div className="fgrid">
            {([["name", "Legal name"], ["dba", "DBA"], ["category", "Category"], ["contact_name", "Contact"], ["email", "Email"], ["phone", "Phone"], ["address", "Remit-to address"], ["payment_terms", "Terms"]] as [keyof Vendor, string][]).map(([k, l]) => (
              <Field key={k} label={l} id={"v" + k}><input id={"v" + k} required={k === "name"} value={(edit as any)[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>
            ))}
            <Field label="Pays by" id="vRem"><select id="vRem" value={edit.remit_method} onChange={(e) => setEdit({ ...edit, remit_method: e.target.value })}>
              <option value="ach">ACH</option><option value="check">Check</option><option value="card">Card</option><option value="wire">Wire</option><option value="autopay">Autopay</option></select></Field>
            <Field label="Default expense account" id="vGl"><select id="vGl" value={edit.default_gl || ""} onChange={(e) => setEdit({ ...edit, default_gl: e.target.value || null })}>
              <option value="">None</option>{lk.data.gl.filter((g) => g.type === "expense").map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select></Field>
            <Field label="Tax ID · last 4 digits" id="vTax"><input id="vTax" maxLength={4} inputMode="numeric" value={edit.tax_id_last4 || ""} onChange={(e) => setEdit({ ...edit, tax_id_last4: e.target.value.replace(/\D/g, "") || null })} /></Field>
            <Field label="Status" id="vSt"><select id="vSt" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
          </div>
          <div className="acts" style={{ marginTop: 12 }}>
            <label className="check-row" htmlFor="vW9"><input id="vW9" type="checkbox" checked={!!edit.w9_on_file} onChange={(e) => setEdit({ ...edit, w9_on_file: e.target.checked })} /> W-9 on file</label>
            <label className="check-row" htmlFor="v99"><input id="v99" type="checkbox" checked={!!edit.is_1099} onChange={(e) => setEdit({ ...edit, is_1099: e.target.checked })} /> Gets a 1099</label>
          </div>
        </Modal>
      )}
    </>
  );
}

// ======================= Purchasing =======================
const PO_STATUS: Record<string, [string, "good" | "warn" | "bad" | "info" | "mute"]> = {
  draft: ["Draft", "mute"], submitted: ["Waiting for approval", "warn"], approved: ["Approved", "info"], rejected: ["Rejected", "bad"],
  ordered: ["Ordered", "info"], received: ["Received", "good"], closed: ["Closed", "mute"],
};
export function Purchasing({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState("");
  const canEdit = ctx.can("purchasing", "edit"), canApprove = ctx.can("purchasing", "approve");
  const lk = useLookups(ctx);
  const depts = useAsync(() => db.get<any>(`departments?select=id,name,color&tenant_id=eq.${ctx.tenant.id}&order=sort.asc`), []);
  const q = useAsync(() => db.get<any>(`purchase_orders?select=*,po_lines(*)&tenant_id=eq.${ctx.tenant.id}${hotelId ? `&hotel_id=eq.${hotelId}` : ""}&order=created_at.desc&limit=200`), [hotelId]);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const [deciding, setDeciding] = useState<{ po: any; approve: boolean } | null>(null);
  const vName = (id: string | null) => lk.data?.vendors.find((v) => v.id === id)?.name || "—";
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";
  async function advance(po: any, to: string) {
    try { await db.rpc("advance_po", { p_id: po.id, p_to: to }); setMsg({ kind: "good", text: to === "received" ? "Marked received. A draft bill was created for accounts payable." : `Order marked ${to}.` }); q.reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  async function save(submit: boolean) {
    try {
      const lines = form.lines.filter((l: any) => l.item && Number(l.qty) > 0);
      if (!lines.length) throw new Error("Add at least one item.");
      const total = lines.reduce((a: number, l: any) => a + Number(l.qty) * Number(l.unit_cost || 0), 0);
      const po = (await db.insert<any>("purchase_orders", { tenant_id: ctx.tenant.id, hotel_id: form.hotel_id, vendor_id: form.vendor_id || null, department_id: form.department_id || null,
        po_no: `PO-${todayIn().slice(2, 4)}${todayIn().slice(5, 7)}-${Math.floor(Date.now() / 1000) % 100000}`, status: submit ? "submitted" : "draft", needed_by: form.needed_by || null,
        notes: form.notes || null, total: Math.round(total * 100) / 100 }, "id"))[0];
      await db.insert("po_lines", lines.map((l: any) => ({ po_id: po.id, tenant_id: ctx.tenant.id, hotel_id: form.hotel_id, item: l.item, qty: Number(l.qty), unit_cost: Number(l.unit_cost || 0), gl_account_id: l.gl_account_id || null })), "id");
      setForm(null); setMsg({ kind: "good", text: submit ? "Purchase order sent for approval." : "Draft saved." }); q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  const pending = (q.data || []).filter((p: any) => p.status === "submitted");
  return (
    <>
      <PageHead eyebrow="Operations" title="Purchasing" desc="Request → approve (within each person's limit) → order → receive. Receiving creates the bill for accounts payable."
        actions={canEdit && <button className="btn pri" onClick={() => setForm({ hotel_id: hotelId || operating[0]?.id, vendor_id: "", department_id: "", needed_by: addDays(todayIn(), 7), notes: "", lines: [{ item: "", qty: 1, unit_cost: "", gl_account_id: "" }] })}>New purchase order</button>} />
      <div className="toolbar"><HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} all /><span className="grow" />{pending.length > 0 && <Pill kind="warn">{pending.length} waiting for approval</Pill>}</div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush>
          {q.data.length ? <div className="tw"><table>
            <thead><tr><th>PO</th>{!hotelId && <th>Hotel</th>}<th>Vendor</th><th>Department</th><th>Items</th><th>Needed by</th><th className="n">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>{q.data.map((p: any) => {
              const d = depts.data?.find((x: any) => x.id === p.department_id);
              return (
                <tr key={p.id}>
                  <td className="nowrap"><b>{p.po_no}</b> <SampleBadge show={p.data_source === "sample"} /></td>
                  {!hotelId && <td className="small">{hName(p.hotel_id)}</td>}
                  <td>{vName(p.vendor_id)}</td>
                  <td className="nowrap small">{d && <i className="dot" style={{ background: d.color }} />}{d?.name || "—"}</td>
                  <td className="small">{p.po_lines.map((l: any) => `${Number(l.qty)} × ${l.item}`).join("; ")}</td>
                  <td className="small nowrap">{p.needed_by ? fmtDate(p.needed_by) : "—"}</td>
                  <td className="n"><b>{usd(Number(p.total), 2)}</b></td>
                  <td><Pill kind={PO_STATUS[p.status][1]}>{PO_STATUS[p.status][0]}</Pill>{p.decision_note && <div className="tag">{p.decision_note}</div>}</td>
                  <td><div className="row-actions">
                    {p.status === "draft" && canEdit && <button className="btn sm" onClick={async () => { await db.update("purchase_orders", `id=eq.${p.id}`, { status: "submitted" }, "id").catch((e) => setMsg({ kind: "bad", text: e.message })); q.reload(); }}>Submit</button>}
                    {p.status === "submitted" && canApprove && <><button className="btn sm" onClick={() => setDeciding({ po: p, approve: false })}>Reject</button><button className="btn sm pri" onClick={() => setDeciding({ po: p, approve: true })}>Approve</button></>}
                    {p.status === "approved" && canEdit && <button className="btn sm" onClick={() => advance(p, "ordered")}>Mark ordered</button>}
                    {(p.status === "ordered" || p.status === "approved") && canEdit && <button className="btn sm" onClick={() => advance(p, "received")}>Receive</button>}
                    {p.status === "received" && canEdit && <button className="btn sm" onClick={() => advance(p, "closed")}>Close</button>}
                  </div></td>
                </tr>
              );
            })}</tbody></table></div> : <Empty title="No purchase orders yet." />}
        </Card>
      )}
      {form && lk.data && (
        <Modal title="New purchase order" onClose={() => setForm(null)} wide
          footer={<><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn" onClick={() => save(false)}>Save draft</button><button className="btn pri" onClick={() => save(true)}>Submit for approval</button></>}>
          <div className="fgrid">
            <Field label="Hotel" id="poH"><HotelSelect hotels={operating} value={form.hotel_id} onChange={(v) => setForm({ ...form, hotel_id: v })} id="poH" /></Field>
            <Field label="Vendor" id="poV"><select id="poV" value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}><option value="">Choose…</option>{lk.data.vendors.filter((v) => v.status === "active").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field label="Department" id="poD"><select id="poD" value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}><option value="">—</option>{(depts.data || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="Needed by" id="poN"><input id="poN" type="date" value={form.needed_by} onChange={(e) => setForm({ ...form, needed_by: e.target.value })} /></Field>
          </div>
          <h4 style={{ margin: "16px 0 8px" }}>Items</h4>
          <div className="tw"><table>
            <thead><tr><th>Item</th><th className="n">Qty</th><th className="n">Unit cost</th><th>Account</th><th className="n">Line total</th><th></th></tr></thead>
            <tbody>{form.lines.map((l: any, i: number) => {
              const set = (k: string, v: any) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) });
              return (
                <tr key={i}>
                  <td><input aria-label="Item" value={l.item} onChange={(e) => set("item", e.target.value)} style={{ width: "100%" }} /></td>
                  <td><input aria-label="Quantity" type="number" min="0" step="1" value={l.qty} onChange={(e) => set("qty", e.target.value)} style={{ width: 70 }} /></td>
                  <td><input aria-label="Unit cost" type="number" min="0" step="0.01" value={l.unit_cost} onChange={(e) => set("unit_cost", e.target.value)} style={{ width: 100 }} /></td>
                  <td><select aria-label="Account" value={l.gl_account_id} onChange={(e) => set("gl_account_id", e.target.value)}><option value="">—</option>{lk.data!.gl.filter((g) => g.type === "expense").map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select></td>
                  <td className="n">{usd(Number(l.qty || 0) * Number(l.unit_cost || 0), 2)}</td>
                  <td>{form.lines.length > 1 && <button className="btn sm" onClick={() => setForm({ ...form, lines: form.lines.filter((_: any, j: number) => j !== i) })} aria-label="Remove line">×</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <div className="acts" style={{ marginTop: 8, justifyContent: "space-between" }}>
            <button className="btn sm" onClick={() => setForm({ ...form, lines: [...form.lines, { item: "", qty: 1, unit_cost: "", gl_account_id: "" }] })}>Add item</button>
            <b>Total {usd(form.lines.reduce((a: number, l: any) => a + Number(l.qty || 0) * Number(l.unit_cost || 0), 0), 2)}</b>
          </div>
          <Field label="Notes" id="poNotes"><input id="poNotes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </Modal>
      )}
      {deciding && <DecideModal what="purchase order" name={`${deciding.po.po_no} · ${usd(Number(deciding.po.total), 2)}`} approve={deciding.approve}
        onConfirm={async (note) => { await db.rpc("decide_po", { p_id: deciding.po.id, p_approve: deciding.approve, p_note: note || null }); }}
        onClose={(ok) => { setDeciding(null); if (ok) { setMsg({ kind: "good", text: ok }); q.reload(); } }} />}
    </>
  );
}

// ======================= Banking & reconciliation =======================
const MATCH_LABEL: Record<string, string> = { deposit: "Deposit", deposit_batch: "Card batch", deposit_amex: "Amex (net of fees)", bill: "Bill payment", gl: "Assigned to account" };
export function Banking({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("finance", "edit");
  const accts = useAsync(async () => {
    const [a, un] = await Promise.all([
      db.get<BankAcct>(`bank_accounts?select=*&tenant_id=eq.${ctx.tenant.id}&order=name.asc`),
      db.get<any>(`bank_transactions?select=bank_account_id&tenant_id=eq.${ctx.tenant.id}&status=eq.unmatched`),
    ]);
    return { a, un };
  }, [ctx.tenant.id]);
  const [acctId, setAcctId] = useState("");
  const acct = accts.data?.a.find((a) => a.id === acctId) || accts.data?.a[0];
  const [view, setView] = useState<"unmatched" | "matched" | "all">("unmatched");
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [preview, setPreview] = useState<(BankParse & { file: File }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState<any | null>(null);
  const [addAcct, setAddAcct] = useState<any | null>(null);
  const [feeds, setFeeds] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const tx = useAsync(() => acct ? db.get<any>(`bank_transactions?select=*&bank_account_id=eq.${acct.id}${view === "all" ? "" : `&status=eq.${view}`}&order=posted_date.desc&limit=400`) : Promise.resolve([]), [acct?.id, view]);
  const imports = useAsync(() => acct ? db.get<any>(`statement_imports?select=*&bank_account_id=eq.${acct.id}&order=created_at.desc&limit=5`) : Promise.resolve([]), [acct?.id, tx.data]);
  const expected = useAsync(() => acct ? db.get<any>(`expected_deposits?select=*&hotel_id=eq.${acct.hotel_id}&status=eq.open&expected_date=lte.${todayIn()}&order=expected_date.asc&limit=200`) : Promise.resolve([]), [acct?.id, tx.data]);
  const lk = useLookups(ctx);
  const unmatchedOf = (id: string) => accts.data?.un.filter((u: any) => u.bank_account_id === id).length || 0;

  async function onFile(f: File) {
    setMsg(null);
    try {
      const r = await readBankStatement(f);
      if (!r.rows.length) { setMsg({ kind: "bad", text: r.warnings[0] || "No transactions found in that file." }); return; }
      setPreview({ ...r, file: f });
    } catch (e: any) { setMsg({ kind: "bad", text: `Couldn't read ${f.name}: ${e.message}` }); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  }
  async function saveImport() {
    if (!preview || !acct) return;
    setBusy(true);
    try {
      const r = await db.rpc<any>("import_bank_transactions", { p_account: acct.id, p_rows: preview.rows, p_meta: { file_name: preview.file.name, format: preview.format, from: preview.from, to: preview.to, opening: preview.opening ?? null, closing: preview.closing ?? null, ms: preview.ms } });
      const matched = r.matched_deposits + r.matched_batches + r.matched_amex + r.matched_bills;
      setMsg({ kind: "good", text: `${r.added} new transactions saved${r.duplicates ? ` (${r.duplicates} already imported, skipped)` : ""}. ${matched} matched automatically.` });
      setPreview(null); tx.reload(); accts.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function autoMatch() {
    if (!acct) return;
    setBusy(true);
    try {
      const r = await db.rpc<any>("auto_reconcile", { p_account: acct.id });
      const n = r.matched_deposits + r.matched_batches + r.matched_amex + r.matched_bills;
      setMsg({ kind: n ? "good" : "info", text: n ? `Matched ${n}: ${r.matched_deposits} deposits, ${r.matched_batches} card batches, ${r.matched_amex} Amex, ${r.matched_bills} bill payments.` : "Nothing new to match. What's left needs a quick decision below." });
      tx.reload(); accts.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function act(t: any, kind: string, ids: string[] = [], gl?: string) {
    try { await db.rpc("match_transaction", { p_tx: t.id, p_kind: kind, p_ids: ids, p_gl: gl || null }); setMatching(null); tx.reload(); accts.reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  async function checkFeeds() {
    try { const r = await callFunction<any>("bank-feeds", { action: "status" }); setFeeds(r.message); }
    catch { setFeeds("Bank feeds aren't switched on yet. Add Plaid or Finicity keys to the project (one-time setup), then connect each bank here."); }
  }
  const rows = tx.data || [];
  const totals = rows.reduce((a: any, t: any) => ({ in: a.in + (t.amount > 0 ? Number(t.amount) : 0), out: a.out + (t.amount < 0 ? -Number(t.amount) : 0) }), { in: 0, out: 0 });

  return (
    <>
      <PageHead eyebrow="Finance" title="Banking & Reconciliation" desc="Bank feeds where available, any statement file where not. Deposits match to the night audit automatically."
        actions={<>
          <button className="btn" onClick={checkFeeds}>Connect bank feed</button>
          {ctx.can("finance", "approve") && <button className="btn" onClick={() => setAddAcct({ hotel_id: ctx.hotels.find((h) => h.status === "operating")?.id, name: "", institution: "", last4: "", kind: "operating" })}>Add bank account</button>}
        </>} />
      {feeds && <Notice kind="info" onClose={() => setFeeds("")}>{feeds}</Notice>}
      {accts.loading && !accts.data && <Loading />}
      {accts.error && <ErrorBox error={accts.error} retry={accts.reload} />}
      {accts.data && !accts.data.a.length && <Empty title="No bank accounts yet.">Add each hotel's operating account to start reconciling.</Empty>}
      {accts.data && acct && (
        <>
          <div className="acct-cards">
            {accts.data.a.map((a) => (
              <button key={a.id} type="button" className={"acct" + (a.id === acct.id ? " on" : "")} onClick={() => setAcctId(a.id)}>
                <span className="tag">{a.institution} ••{a.last4} · {a.feed === "manual" ? "statements" : a.feed}</span>
                <b>{a.name}</b>
                <span className="v">{a.balance != null ? usd(Number(a.balance), 2) : "—"}</span>
                <span className="tag">{a.balance_as_of ? `as of ${fmtDate(a.balance_as_of)}` : "no balance yet"}{unmatchedOf(a.id) ? ` · ${unmatchedOf(a.id)} to review` : " · reconciled"}</span>
              </button>
            ))}
          </div>
          <div className="sp" />
          <div className="grid g-2-1">
            <div>
              <div className="toolbar">
                <Seg label="Show" value={view} onChange={setView} options={[["unmatched", "To review"], ["matched", "Matched"], ["all", "All"]]} />
                <span className="grow" />
                <span className="small muted">In {usd(totals.in, 2)} · Out {usd(totals.out, 2)}</span>
                {canEdit && <button className="btn" disabled={busy} onClick={autoMatch}>Auto-match now</button>}
              </div>
              {msg && <Notice kind={msg.kind === "info" ? "info" : msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
              <Card flush>
                {tx.loading && !tx.data ? <Loading /> : rows.length ? (
                  <div className="tw"><table>
                    <thead><tr><th>Date</th><th>Description</th><th className="n">Amount</th><th>Match</th><th></th></tr></thead>
                    <tbody>{rows.map((t: any) => (
                      <tr key={t.id}>
                        <td className="nowrap small">{fmtDate(t.posted_date)}</td>
                        <td><span className="small">{t.description}</span>{t.ref && <span className="chip" style={{ marginLeft: 6 }}>#{t.ref}</span>} <SampleBadge show={t.data_source === "sample"} /></td>
                        <td className={"n " + (t.amount > 0 ? "up" : "")}><b>{usd(Number(t.amount), 2)}</b></td>
                        <td>{t.status === "matched" ? <><Pill kind="good">{MATCH_LABEL[t.matched_kind] || "Matched"}</Pill>{Number(t.variance) ? <div className="tag">Fees {usd(Number(t.variance), 2)}</div> : null}</>
                          : t.status === "excluded" ? <Pill kind="mute">Excluded</Pill> : <Pill kind="warn">To review</Pill>}</td>
                        <td>{canEdit && (t.status === "unmatched" ? <button className="btn sm" onClick={() => setMatching(t)}>Resolve</button>
                          : <button className="btn sm" onClick={() => act(t, "unmatch")}>Undo</button>)}</td>
                      </tr>
                    ))}</tbody></table></div>
                ) : <Empty title={view === "unmatched" ? "Everything is reconciled." : "No transactions."} />}
              </Card>
            </div>
            <div className="grid" style={{ alignContent: "start" }}>
              {canEdit && (
                <Card title="Upload a statement">
                  <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.dataTransfer.files[0] && onFile(e.dataTransfer.files[0]); }}>
                    <b>Drop a statement for {acct.name}</b>
                    <span className="small muted">CSV · OFX · QFX · BAI2 · Excel · PDF — read in your browser in about a second. Duplicates are skipped.</span>
                    <label className="btn" htmlFor="stmtFile">Choose file</label>
                    <input id="stmtFile" ref={fileRef} type="file" hidden accept=".csv,.txt,.ofx,.qfx,.bai,.bai2,.xlsx,.xlsm,.xls,.pdf" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
                  </div>
                  {imports.data && imports.data.length > 0 && (
                    <div className="list" style={{ marginTop: 10 }}>{imports.data.map((i: any) => (
                      <div className="li" key={i.id} style={{ padding: "8px 0" }}><div><div className="t small">{i.file_name}</div>
                        <div className="s">{i.format} · {i.rows_added} added{i.duplicates ? `, ${i.duplicates} duplicate` : ""} · read in {i.ms_to_read ?? "—"} ms</div></div></div>
                    ))}</div>
                  )}
                </Card>
              )}
              <Card title="Deposits not yet in the bank" note={`${(expected.data || []).length}`} flush>
                {(expected.data || []).length ? (
                  <div className="list">{(expected.data || []).slice(0, 12).map((e: any) => {
                    const late = e.expected_date < addDays(todayIn(), -3);
                    return (
                      <div className="li" key={e.id} style={{ padding: "9px 18px" }}>
                        <span className="stripe" style={{ background: late ? "var(--bad)" : "var(--warn)" }} />
                        <div><div className="t small">{e.source.replace("_", " ")} · {usd(Number(e.amount), 2)}</div><div className="s">Night of {fmtDate(e.business_date)} · expected {fmtDate(e.expected_date)}</div></div>
                        {late && <div className="r"><Pill kind="bad">Late</Pill></div>}
                      </div>
                    );
                  })}</div>
                ) : <Empty title="All expected deposits have arrived." />}
              </Card>
            </div>
          </div>
        </>
      )}
      {preview && (
        <Modal title={`Check ${preview.file.name}`} onClose={() => setPreview(null)} wide
          footer={<><button className="btn" onClick={() => setPreview(null)}>Cancel</button><button className="btn pri" disabled={busy} onClick={saveImport}>{busy ? "Saving…" : `Save ${preview.rows.length} transactions & auto-match`}</button></>}>
          <div className="stat-row">
            <Kpi label="Format" value={preview.format} />
            <Kpi label="Transactions" value={preview.rows.length} />
            <Kpi label="Period" value={<span style={{ fontSize: 15 }}>{preview.from ? fmtDate(preview.from) : "?"} – {preview.to ? fmtDate(preview.to) : "?"}</span>} />
            <Kpi label="Read in" value={`${preview.ms} ms`} />
          </div>
          <p className="small" style={{ marginTop: 0 }}>Deposits {usd(preview.rows.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0), 2)} · Withdrawals {usd(-preview.rows.filter((r) => r.amount < 0).reduce((a, r) => a + r.amount, 0), 2)}
            {preview.closing != null && ` · Ending balance ${usd(preview.closing, 2)}`}</p>
          {preview.warnings.map((w) => <Notice key={w} kind="info">{w}</Notice>)}
          <div className="tw" style={{ maxHeight: 340, overflowY: "auto" }}><table>
            <thead><tr><th>Date</th><th>Description</th><th>Ref</th><th className="n">Amount</th></tr></thead>
            <tbody>{preview.rows.slice(0, 300).map((r, i) => <tr key={i}><td className="small nowrap">{fmtDate(r.date)}</td><td className="small">{r.description}</td><td className="small">{r.ref}</td><td className={"n " + (r.amount > 0 ? "up" : "")}>{usd(r.amount, 2)}</td></tr>)}</tbody>
          </table></div>
        </Modal>
      )}
      {matching && <ResolveModal t={matching} expected={expected.data || []} gl={lk.data?.gl || []} onClose={() => setMatching(null)} act={act} />}
      {addAcct && (
        <Modal title="Add bank account" onClose={() => setAddAcct(null)} onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (addAcct.last4 && !/^\d{4}$/.test(addAcct.last4)) throw new Error("Enter only the last 4 digits of the account number.");
            const gl = lk.data?.gl.find((g) => g.number === (addAcct.kind === "payroll" ? "1010" : "1000"));
            await db.insert("bank_accounts", { ...addAcct, tenant_id: ctx.tenant.id, last4: addAcct.last4 || null, gl_account_id: gl?.id || null }, "id");
            setAddAcct(null); accts.reload();
          } catch (err: any) { setMsg({ kind: "bad", text: err.message }); setAddAcct(null); }
        }} footer={<><button type="button" className="btn" onClick={() => setAddAcct(null)}>Cancel</button><button className="btn pri">Add account</button></>}>
          <div className="fgrid">
            <Field label="Hotel" id="baH"><HotelSelect hotels={ctx.hotels} value={addAcct.hotel_id} onChange={(v) => setAddAcct({ ...addAcct, hotel_id: v })} id="baH" /></Field>
            <Field label="Account name" id="baN"><input id="baN" required value={addAcct.name} onChange={(e) => setAddAcct({ ...addAcct, name: e.target.value })} placeholder="e.g. Operating" /></Field>
            <Field label="Bank" id="baB"><input id="baB" value={addAcct.institution} onChange={(e) => setAddAcct({ ...addAcct, institution: e.target.value })} /></Field>
            <Field label="Account number · last 4" id="baL"><input id="baL" maxLength={4} inputMode="numeric" value={addAcct.last4} onChange={(e) => setAddAcct({ ...addAcct, last4: e.target.value.replace(/\D/g, "") })} /></Field>
            <Field label="Type" id="baK"><select id="baK" value={addAcct.kind} onChange={(e) => setAddAcct({ ...addAcct, kind: e.target.value })}><option value="operating">Operating</option><option value="payroll">Payroll</option><option value="reserve">Reserve (FF&E)</option><option value="tax">Tax</option><option value="other">Other</option></select></Field>
          </div>
          <p className="small muted">Only the last 4 digits are stored. Full account and routing numbers never go into the portal.</p>
        </Modal>
      )}
    </>
  );
}

function ResolveModal({ t, expected, gl, onClose, act }: { t: any; expected: any[]; gl: Gl[]; onClose: () => void; act: (t: any, kind: string, ids?: string[], gl?: string) => void }) {
  const near = expected.filter((e) => Math.abs((Date.parse(e.expected_date) - Date.parse(t.posted_date)) / 864e5) <= 6);
  const [pick, setPick] = useState<string[]>([]);
  const [glId, setGlId] = useState("");
  const sum = near.filter((e) => pick.includes(e.id)).reduce((a, e) => a + Number(e.amount), 0);
  return (
    <Modal title="Resolve transaction" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      <p style={{ marginTop: 0 }}><b>{usd(Number(t.amount), 2)}</b> · {fmtDate(t.posted_date)} · {t.description}</p>
      {t.amount > 0 && (
        <Card title="Match to expected deposits" note={near.length ? `Selected ${usd(sum, 2)} · difference ${usd(Number(t.amount) - sum, 2)}` : undefined}>
          {near.length ? (
            <>
              <div className="list">{near.map((e) => (
                <label key={e.id} className="check-row" htmlFor={"ed" + e.id} style={{ padding: "6px 0" }}>
                  <input id={"ed" + e.id} type="checkbox" checked={pick.includes(e.id)} onChange={(ev) => setPick(ev.target.checked ? [...pick, e.id] : pick.filter((x) => x !== e.id))} />
                  {e.source.replace("_", " ")} · {usd(Number(e.amount), 2)} · night of {fmtDate(e.business_date)}
                </label>
              ))}</div>
              <button className="btn pri" style={{ marginTop: 10 }} disabled={!pick.length} onClick={() => act(t, "deposit", pick)}>Match selected</button>
            </>
          ) : <p className="small muted" style={{ margin: 0 }}>No open expected deposits within 6 days of this date.</p>}
        </Card>
      )}
      <div className="sp" />
      <Card title="Or assign to an account">
        <div className="acts">
          <select aria-label="Account" value={glId} onChange={(e) => setGlId(e.target.value)} style={{ minWidth: 280 }}>
            <option value="">Choose account…</option>{gl.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}
          </select>
          <button className="btn pri" disabled={!glId} onClick={() => act(t, "gl", [], glId)}>Assign</button>
          <button className="btn" onClick={() => act(t, "exclude")}>Exclude (transfer / duplicate)</button>
        </div>
      </Card>
    </Modal>
  );
}

// ======================= Accounting: P&L, budget, journal, chart of accounts =======================
type PnlRow = { section: string; account: string; number: string; kind: string; actual: number; budget: number | null; last_year: number | null };
export function Accounting({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<"pnl" | "budget" | "journal" | "coa">("pnl");
  return (
    <>
      <PageHead eyebrow="Finance" title="Accounting" desc="Profit & loss against budget and last year, budgets by month, journal entries and the chart of accounts."
        actions={<button className="btn" onClick={() => window.print()}>Print</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[["pnl", "Profit & Loss"], ["budget", "Budget"], ["journal", "Journal"], ["coa", "Chart of accounts"]]} />
      {tab === "pnl" && <Pnl ctx={ctx} />}
      {tab === "budget" && <BudgetEditor ctx={ctx} />}
      {tab === "journal" && <Journal ctx={ctx} />}
      {tab === "coa" && <ChartOfAccounts ctx={ctx} />}
    </>
  );
}

function Pnl({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState("");
  const [period, setPeriod] = useState<Period | "LM">("MTD");
  const range: [string, string] = period === "LM"
    ? (() => { const first = `${yesterday().slice(0, 7)}-01`; const lmEnd = addDays(first, -1); return [`${lmEnd.slice(0, 7)}-01`, lmEnd] as [string, string]; })()
    : periodRange(period as Period);
  const q = useAsync(() => db.rpc<PnlRow[]>("pnl", { p_from: range[0], p_to: range[1], p_hotels: hotelId ? [hotelId] : null }), [hotelId, range[0], range[1]]);
  const rows = q.data || [];
  const rev = rows.filter((r) => r.kind === "revenue");
  const exp = rows.filter((r) => r.kind === "expense");
  const S = (rs: PnlRow[], k: "actual" | "budget" | "last_year") => rs.reduce((a, r) => a + Number(r[k] || 0), 0);
  const sections = useMemo(() => {
    const m = new Map<string, PnlRow[]>();
    exp.forEach((r) => m.set(r.section, [...(m.get(r.section) || []), r]));
    return [...m.entries()];
  }, [q.data]);
  const totalRev = S(rev, "actual"), totalRevB = S(rev, "budget"), totalRevLY = S(rev, "last_year");
  const gop = totalRev - S(exp, "actual"), gopB = totalRevB - S(exp, "budget"), gopLY = totalRevLY - S(exp, "last_year");
  const line = (label: string, a: number, b: number | null, ly: number | null, opts: { bold?: boolean; expense?: boolean; indent?: boolean } = {}) => {
    const v = b ? a - b : null;
    const good = v == null ? null : opts.expense ? v <= 0 : v >= 0;
    return (
      <tr key={label} style={opts.bold ? { fontWeight: 700, background: "var(--surface-2)" } : undefined}>
        <td style={{ paddingLeft: opts.indent ? 28 : undefined }}>{label}</td>
        <td className="n">{usd(a)}</td><td className="n">{totalRev ? pct(a / totalRev) : "—"}</td>
        <td className="n">{b != null ? usd(b) : "—"}</td>
        <td className={"n " + (good == null ? "" : good ? "up" : "dn")}>{v != null ? usd(v) : "—"}</td>
        <td className="n">{ly ? usd(ly) : "—"}</td>
      </tr>
    );
  };
  function exportCsv() {
    downloadFile(`pnl_${range[0]}_${range[1]}.csv`, toCsv([["Section", "Account", "Actual", "Budget", "Last year"], ...rows.map((r) => [r.section, `${r.number} ${r.account}`, r.actual, r.budget, r.last_year])]));
  }
  return (
    <>
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} all />
        <Seg label="Period" value={period} onChange={setPeriod} options={[["MTD", "Month to date"], ["LM", "Last month"], ["YTD", "Year to date"]]} />
        <span className="small muted">{fmtDate(range[0])} – {fmtDate(range[1])}</span>
        <span className="grow" /><button className="btn" onClick={exportCsv}>Export</button>
      </div>
      <div className="stat-row">
        <Kpi label="Total revenue" value={usd(totalRev)} delta={totalRevB ? <span className={"d " + (totalRev >= totalRevB ? "up" : "dn")}>{pct(totalRev / totalRevB - 1)} vs budget</span> : undefined} />
        <Kpi label="Total expenses" value={usd(S(exp, "actual"))} />
        <Kpi label="Profit (GOP proxy)" value={usd(gop)} delta={gopB ? <span className={"d " + (gop >= gopB ? "up" : "dn")}>{usd(gop - gopB)} vs budget</span> : undefined} />
        <Kpi label="Profit margin" value={totalRev ? pct(gop / totalRev) : "—"} delta={totalRevLY ? <span className="tag">LY {pct(gopLY / totalRevLY)}</span> : undefined} />
      </div>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush>
          <div className="tw"><table>
            <thead><tr><th>Account</th><th className="n">Actual</th><th className="n">% of rev</th><th className="n">Budget</th><th className="n">Variance</th><th className="n">Last year</th></tr></thead>
            <tbody>
              {rev.map((r) => line(r.account, Number(r.actual), r.budget != null ? Number(r.budget) : null, r.last_year != null ? Number(r.last_year) : null, { indent: true }))}
              {line("Total revenue", totalRev, totalRevB || null, totalRevLY || null, { bold: true })}
              {sections.map(([sec, rs]) => (
                <React.Fragment key={sec}>
                  <tr><td colSpan={6} className="tag" style={{ paddingTop: 14, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase" }}>{sec}</td></tr>
                  {rs.map((r) => line(`${r.number} · ${r.account}`, Number(r.actual), r.budget != null ? Number(r.budget) : null, r.last_year != null ? Number(r.last_year) : null, { expense: true, indent: true }))}
                </React.Fragment>
              ))}
              {line("Total expenses", S(exp, "actual"), S(exp, "budget") || null, S(exp, "last_year") || null, { bold: true, expense: true })}
              {line("Net operating profit", gop, gopB || null, gopLY || null, { bold: true })}
            </tbody>
          </table></div>
        </Card>
      )}
      <p className="small muted">Revenue comes from the night audit; expenses from approved bills, payroll and journal entries.</p>
    </>
  );
}

function BudgetEditor({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const year = Number(todayIn().slice(0, 4));
  const canEdit = ctx.can("finance", "edit");
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  const lk = useLookups(ctx);
  const q = useAsync(() => db.get<any>(`budget_gl?select=account_id,month,amount&hotel_id=eq.${hotelId}&month=gte.${year}-01-01&month=lte.${year}-12-01&version=eq.Budget`), [hotelId]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const val = (a: string, m: string) => draft[`${a}|${m}`] ?? String(q.data?.find((r: any) => r.account_id === a && r.month === m)?.amount ?? "");
  async function save() {
    try {
      const rows = Object.entries(draft).map(([k, v]) => { const [account_id, month] = k.split("|"); return { tenant_id: ctx.tenant.id, hotel_id: hotelId, account_id, month, amount: Number(v || 0), version: "Budget" }; });
      if (rows.length) await db.upsert("budget_gl", rows, "hotel_id,account_id,month,version", "account_id");
      setDraft({}); setMsg({ kind: "good", text: `${rows.length} budget cells saved.` }); q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  const accts = (lk.data?.gl || []).filter((g) => g.type === "expense");
  return (
    <>
      <div className="toolbar"><HotelSelect hotels={operating} value={hotelId} onChange={(v) => { setHotelId(v); setDraft({}); }} /><span className="small muted">{year} operating expense budget · rooms revenue budget comes from the daily budget</span>
        <span className="grow" />{canEdit && <button className="btn pri" disabled={!Object.keys(draft).length} onClick={save}>Save {Object.keys(draft).length || ""} changes</button>}</div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {(q.loading || lk.loading) && !q.data && <Loading />}
      {q.data && lk.data && (
        <Card flush>
          <div className="tw"><table className="budget">
            <thead><tr><th>Account</th>{months.map((m) => <th key={m} className="n">{new Date(m + "T12:00:00").toLocaleString("en-US", { month: "short" })}</th>)}<th className="n">Year</th></tr></thead>
            <tbody>{accts.map((a) => {
              const yr = months.reduce((s, m) => s + Number(val(a.id, m) || 0), 0);
              return (
                <tr key={a.id}>
                  <td className="nowrap small"><b>{a.number}</b> {a.name}</td>
                  {months.map((m) => <td key={m} className="n"><input aria-label={`${a.name} ${m}`} className="cell-in" inputMode="decimal" disabled={!canEdit} value={val(a.id, m) ? String(Math.round(Number(val(a.id, m)))) : ""}
                    onChange={(e) => setDraft({ ...draft, [`${a.id}|${m}`]: e.target.value.replace(/[^\d.]/g, "") })} /></td>)}
                  <td className="n"><b>{usd(yr)}</b></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}

function Journal({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const canEdit = ctx.can("finance", "edit");
  const lk = useLookups(ctx);
  const q = useAsync(() => db.get<any>(`journal_entries?select=*,journal_lines(account_id,debit,credit,memo)&hotel_id=eq.${hotelId}&order=entry_date.desc,created_at.desc&limit=60`), [hotelId]);
  const [form, setForm] = useState<any | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const glName = (id: string) => glLabel(lk.data?.gl.find((g) => g.id === id));
  async function post() {
    try {
      const lines = form.lines.filter((l: any) => l.account_id && (Number(l.debit) || Number(l.credit))).map((l: any) => ({ account_id: l.account_id, debit: Number(l.debit || 0), credit: Number(l.credit || 0), memo: l.memo || null }));
      await db.rpc("post_journal", { p_hotel: hotelId, p_date: form.date, p_memo: form.memo, p_lines: lines, p_source: "manual", p_source_id: null });
      setForm(null); setMsg({ kind: "good", text: "Entry posted." }); q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  const dr = form ? form.lines.reduce((a: number, l: any) => a + Number(l.debit || 0), 0) : 0;
  const cr = form ? form.lines.reduce((a: number, l: any) => a + Number(l.credit || 0), 0) : 0;
  return (
    <>
      <div className="toolbar"><HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} /><span className="grow" />
        {canEdit && <button className="btn pri" onClick={() => setForm({ date: todayIn(), memo: "", lines: [{ account_id: "", debit: "", credit: "" }, { account_id: "", debit: "", credit: "" }] })}>New journal entry</button>}</div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.data && lk.data && (
        <Card flush>
          {q.data.length ? <div className="tw"><table>
            <thead><tr><th>Date</th><th>Memo</th><th>Source</th><th>Lines</th><th className="n">Amount</th></tr></thead>
            <tbody>{q.data.map((j: any) => (
              <tr key={j.id}>
                <td className="nowrap small">{fmtDate(j.entry_date)}</td>
                <td>{j.memo} <SampleBadge show={j.data_source === "sample"} /></td>
                <td className="small">{j.source}</td>
                <td className="small">{j.journal_lines.slice(0, 3).map((l: any, i: number) => <div key={i}>{Number(l.debit) ? "Dr" : "Cr"} {glName(l.account_id)}</div>)}{j.journal_lines.length > 3 && <div className="tag">+{j.journal_lines.length - 3} more</div>}</td>
                <td className="n">{usd(j.journal_lines.reduce((a: number, l: any) => a + Number(l.debit), 0), 2)}</td>
              </tr>
            ))}</tbody></table></div> : <Empty title="No journal entries for this hotel yet." />}
        </Card>
      )}
      {form && lk.data && (
        <Modal title="New journal entry" onClose={() => setForm(null)} wide
          footer={<><span className={"small " + (Math.abs(dr - cr) < 0.005 && dr > 0 ? "up" : "dn")} style={{ marginRight: "auto" }}>Debits {usd(dr, 2)} · Credits {usd(cr, 2)}{Math.abs(dr - cr) >= 0.005 ? " · out of balance" : ""}</span>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" disabled={Math.abs(dr - cr) >= 0.005 || !dr} onClick={post}>Post entry</button></>}>
          <div className="fgrid">
            <Field label="Date" id="jD"><input id="jD" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
            <Field label="Memo" id="jM"><input id="jM" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /></Field>
          </div>
          <div className="tw" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Account</th><th className="n">Debit</th><th className="n">Credit</th><th>Memo</th></tr></thead>
            <tbody>{form.lines.map((l: any, i: number) => {
              const set = (k: string, v: any) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) });
              return (
                <tr key={i}>
                  <td><select aria-label="Account" value={l.account_id} onChange={(e) => set("account_id", e.target.value)}><option value="">Choose…</option>{lk.data!.gl.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select></td>
                  <td><input aria-label="Debit" type="number" step="0.01" min="0" value={l.debit} onChange={(e) => set("debit", e.target.value)} style={{ width: 110 }} /></td>
                  <td><input aria-label="Credit" type="number" step="0.01" min="0" value={l.credit} onChange={(e) => set("credit", e.target.value)} style={{ width: 110 }} /></td>
                  <td><input aria-label="Line memo" value={l.memo || ""} onChange={(e) => set("memo", e.target.value)} /></td>
                </tr>
              );
            })}</tbody></table></div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setForm({ ...form, lines: [...form.lines, { account_id: "", debit: "", credit: "" }] })}>Add line</button>
        </Modal>
      )}
    </>
  );
}

function ChartOfAccounts({ ctx }: { ctx: Ctx }) {
  const lk = useLookups(ctx);
  const canAdmin = ctx.can("finance", "admin");
  const [form, setForm] = useState<any | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const groups = ["asset", "liability", "equity", "revenue", "expense"];
  return (
    <>
      <div className="toolbar"><span className="small muted">USALI-style accounts used across every hotel.</span><span className="grow" />
        {canAdmin && <button className="btn pri" onClick={() => setForm({ number: "", name: "", type: "expense", section: "" })}>Add account</button>}</div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {lk.data && (
        <div className="grid g2">{groups.map((g) => (
          <Card key={g} title={({ asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", expense: "Expenses" } as Record<string, string>)[g]} flush>
            <div className="tw"><table><tbody>{lk.data!.gl.filter((a) => a.type === g).map((a) => (
              <tr key={a.id}><td className="num" style={{ width: 70 }}><b>{a.number}</b></td><td>{a.name}</td><td className="small muted">{a.section}</td></tr>
            ))}</tbody></table></div>
          </Card>
        ))}</div>
      )}
      {form && (
        <Modal title="Add account" onClose={() => setForm(null)} onSubmit={async (e) => {
          e.preventDefault();
          try { await db.insert("gl_accounts", { ...form, tenant_id: ctx.tenant.id }, "id"); setForm(null); setMsg({ kind: "good", text: "Account added." }); lk.reload(); }
          catch (err: any) { setMsg({ kind: "bad", text: err.message }); setForm(null); }
        }} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri">Add</button></>}>
          <div className="fgrid">
            <Field label="Number" id="gN"><input id="gN" required value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field>
            <Field label="Name" id="gNm"><input id="gNm" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Type" id="gT"><select id="gT" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</select></Field>
            <Field label="Section" id="gS"><input id="gS" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="e.g. Undistributed — A&G" /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
