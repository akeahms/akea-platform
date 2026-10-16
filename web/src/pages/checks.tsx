// Checks: write a check (expense lines), the print queue (bill payments by check land here too), printing on
// pre-printed stock in the bank account's layout, numbering only after you confirm they printed, void, reprint.
import React, { useMemo, useState } from "react";
import { db } from "../lib/sb";
import { Ctx, usd, fmtDate, todayIn } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, Notice, Tabs, downloadFile, toCsv } from "../ui";
import { BankAcct, CheckLayout, useLookups, glLabel, glPick } from "../lib/books";
import { buildChecksPdf, amountInWords, LAYOUT_LABEL, SAMPLE_CHECK, PrintCheck } from "../lib/checkpdf";

type Check = {
  id: string; hotel_id: string; bank_account_id: string; check_number: number | null; check_date: string; payee_vendor_id: string | null; payee_name: string;
  payee_address: string | null; amount: number; memo: string | null; lines: { account_id: string; debit: number; memo: string | null }[] | null; bill_ids: string[] | null;
  status: "to_print" | "printed" | "voided"; printed_at: string | null; void_reason: string | null; created_at: string;
};
const STATUS: Record<Check["status"], [string, "warn" | "good" | "mute"]> = { to_print: ["To print", "warn"], printed: ["Printed", "good"], voided: ["Void", "mute"] };

export function Checks({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<"queue" | "write" | "all" | "setup">("queue");
  const accts = useAsync(() => db.get<BankAcct>(`bank_accounts?select=*&tenant_id=eq.${ctx.tenant.id}&order=name.asc`), [ctx.tenant.id]);
  const canWrite = ctx.can("finance", "approve");
  return (
    <>
      <PageHead eyebrow="Finance" title="Checks" desc="Write checks, print them on pre-printed check stock, and keep the register. Bills paid by check wait in the print queue." />
      <Tabs value={tab} onChange={setTab} tabs={[["queue", "Print queue"], ["write", "Write a check"], ["all", "All checks"], ["setup", "Printer setup"]]} />
      {accts.loading && !accts.data ? <Loading /> : accts.error ? <ErrorBox error={accts.error} retry={accts.reload} /> : !accts.data?.length ? (
        <Empty title="No bank accounts yet.">Add a bank account under Banking first.</Empty>
      ) : (
        <>
          {!canWrite && tab !== "all" && <Notice kind="info">Writing and printing checks needs finance approval rights. You can see the register under All checks.</Notice>}
          {tab === "queue" && canWrite && <PrintQueue ctx={ctx} accts={accts.data} reloadAccts={accts.reload} />}
          {tab === "write" && canWrite && <WriteCheck ctx={ctx} accts={accts.data} onSaved={(queued) => { accts.reload(); setTab(queued ? "queue" : "all"); }} />}
          {tab === "all" && <AllChecks ctx={ctx} accts={accts.data} />}
          {tab === "setup" && canWrite && <Setup ctx={ctx} accts={accts.data} onSaved={accts.reload} />}
        </>
      )}
    </>
  );
}

// company block printed on the check (top-left), from the hotel's legal entity
function useCompanies(ctx: Ctx) {
  return useAsync(async () => {
    const ents = await db.get<{ id: string; legal_name: string; mailing_address: string | null; physical_address: string | null }>(`entities?select=id,legal_name,mailing_address,physical_address&tenant_id=eq.${ctx.tenant.id}`);
    return (hotelId: string) => {
      const h = ctx.hotels.find((x) => x.id === hotelId);
      const e = ents.find((x) => x.id === h?.entity_id);
      const addr = (e?.mailing_address || e?.physical_address || [h?.address, [h?.city, h?.state].filter(Boolean).join(", ") + (h?.zip ? " " + h.zip : "")].filter(Boolean).join("\n") || "")
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return { name: e?.legal_name || h?.name || "", address: addr };
    };
  }, [ctx.tenant.id]);
}

async function toPrintChecks(cs: Check[], acct: BankAcct, firstNo: number | null, glName: (id: string) => string): Promise<PrintCheck[]> {
  const billIds = cs.flatMap((c) => c.bill_ids || []);
  const bills = billIds.length ? await db.get<{ id: string; invoice_no: string | null; invoice_date: string | null; amount: number }>(`bills?select=id,invoice_no,invoice_date,amount&id=in.(${billIds.join(",")})`) : [];
  return cs.map((c, i) => ({
    number: firstNo != null ? firstNo + i : c.check_number, date: c.check_date, payee: c.payee_name, address: c.payee_address, amount: Number(c.amount), memo: c.memo,
    bankName: `${acct.name}${acct.last4 ? ` ••${acct.last4}` : ""}`,
    stub: c.bill_ids?.length
      ? bills.filter((b) => c.bill_ids!.includes(b.id)).map((b) => ({ left: `Invoice ${b.invoice_no || "—"}`, mid: b.invoice_date ? fmtDate(b.invoice_date) : "", amount: Number(b.amount) }))
      : (c.lines || []).map((l) => ({ left: glName(l.account_id), mid: l.memo || "", amount: Number(l.debit) })),
  }));
}
function openPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  // a same-origin blob tab (no opener needed to print); a blocked pop-up falls back to a download
  const w = window.open(url, "_blank");
  if (!w) downloadFile(name, bytes as BlobPart, "application/pdf");
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// ======================= print queue =======================
function PrintQueue({ ctx, accts, reloadAccts }: { ctx: Ctx; accts: BankAcct[]; reloadAccts: () => void }) {
  const [acctId, setAcctId] = useState(accts[0].id);
  const acct = accts.find((a) => a.id === acctId) || accts[0];
  const q = useAsync(() => db.get<Check>(`checks?select=*&bank_account_id=eq.${acct.id}&status=eq.to_print&order=check_date.asc,created_at.asc`), [acct.id]);
  const lk = useLookups(ctx);
  const companies = useCompanies(ctx);
  const [sel, setSel] = useState<string[]>([]);
  const [first, setFirst] = useState<string>("");
  const [layout, setLayout] = useState<CheckLayout | "">("");
  const [confirm, setConfirm] = useState<{ ids: string[]; first: number } | null>(null);
  const [badFrom, setBadFrom] = useState<string>("all");
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = q.data || [];
  const chosen = rows.filter((c) => sel.includes(c.id));
  const firstNo = Number(first || acct.next_check_number || 1001);
  const glName = (id: string) => glLabel((lk.data?.gl || []).find((g) => g.id === id));
  async function print() {
    setBusy(true); setMsg(null);
    try {
      if (!chosen.length) throw new Error("Choose the checks to print.");
      if (!Number.isInteger(firstNo) || firstNo < 1) throw new Error("Enter the number printed on the first check in the printer.");
      const lay = (layout || acct.check_layout || "voucher_top") as CheckLayout;
      const company = acct.check_print_company !== false ? (companies.data ? companies.data(acct.hotel_id) : null) : null;
      const pdf = await buildChecksPdf(await toPrintChecks(chosen, acct, firstNo, glName), { layout: lay, offsetX: Number(acct.check_offset_x || 0), offsetY: Number(acct.check_offset_y || 0), company });
      openPdf(pdf, `checks-${firstNo}.pdf`);
      setConfirm({ ids: chosen.map((c) => c.id), first: firstNo }); setBadFrom("all");
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function confirmPrinted() {
    if (!confirm) return;
    setBusy(true);
    try {
      // everything before the first one that didn't come out right gets its number; the rest stay in the queue
      const cut = badFrom === "all" ? confirm.ids.length : confirm.ids.indexOf(badFrom);
      const ok = confirm.ids.slice(0, Math.max(0, cut));
      if (ok.length) await db.rpc("mark_checks_printed", { p_ids: ok, p_first: confirm.first });
      setMsg({ kind: "good", text: ok.length === confirm.ids.length ? `${ok.length} check${ok.length === 1 ? "" : "s"} printed: numbers ${confirm.first}–${confirm.first + ok.length - 1}.`
        : `${ok.length} marked printed. ${confirm.ids.length - ok.length} stay in the queue to print again.` });
      setConfirm(null); setSel([]); setFirst(""); q.reload(); reloadAccts();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="toolbar">
        <select aria-label="Bank account" value={acct.id} onChange={(e) => { setAcctId(e.target.value); setSel([]); setFirst(""); }}>
          {accts.map((a) => <option key={a.id} value={a.id}>{a.name} ••{a.last4} · {ctx.hotels.find((h) => h.id === a.hotel_id)?.name}</option>)}
        </select>
        <label className="small" htmlFor="pqF">First check number</label>
        <input id="pqF" inputMode="numeric" style={{ width: 110 }} value={first} placeholder={String(acct.next_check_number || 1001)} onChange={(e) => setFirst(e.target.value.replace(/\D/g, ""))} />
        <select aria-label="Check layout" value={layout || acct.check_layout || "voucher_top"} onChange={(e) => setLayout(e.target.value as CheckLayout)}>
          {(Object.keys(LAYOUT_LABEL) as CheckLayout[]).map((k) => <option key={k} value={k}>{LAYOUT_LABEL[k]}</option>)}
        </select>
        <span className="grow" />
        <span className="small muted">{chosen.length} selected · {usd(chosen.reduce((a, c) => a + Number(c.amount), 0), 2)}</span>
        <button className="btn pri" disabled={busy || !chosen.length} onClick={print}>Preview & print</button>
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <Card flush>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : !rows.length ? <Empty title="Nothing waiting to print.">Write a check, or pay approved bills by check, and it appears here.</Empty> : (
          <div className="tw"><table>
            <thead><tr><th style={{ width: 34 }}><input type="checkbox" aria-label="Select all" checked={sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((c) => c.id) : [])} /></th>
              <th>Date</th><th>Payee</th><th>For</th><th className="n">Amount</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className={sel.includes(c.id) ? "sel" : ""}>
                <td><input type="checkbox" aria-label={`Select ${c.payee_name}`} checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} /></td>
                <td className="small nowrap">{fmtDate(c.check_date)}</td>
                <td><b>{c.payee_name}</b>{c.payee_address && <div className="tag">{c.payee_address.split(/\r?\n/)[0]}</div>}</td>
                <td className="small">{c.bill_ids?.length ? `Bill payment · ${c.bill_ids.length} bill${c.bill_ids.length === 1 ? "" : "s"}` : (c.lines || []).map((l) => glName(l.account_id)).join(", ")}{c.memo ? <div className="tag">{c.memo}</div> : null}</td>
                <td className="n"><b>{usd(Number(c.amount), 2)}</b></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <p className="small muted">Load the check stock with the check face up and the first check number in the printer matching the number above. Print at “Actual size” (not “Fit to page”). Line the printer up once under Printer setup.</p>
      {confirm && (
        <Modal title="Did your checks print correctly?" onClose={() => setConfirm(null)}
          footer={<><button type="button" className="btn" onClick={() => setConfirm(null)}>Not yet — keep them in the queue</button><button type="button" className="btn pri" disabled={busy} onClick={confirmPrinted}>Done</button></>}>
          <p style={{ marginTop: 0 }}>The checks opened in a new tab for printing as numbers {confirm.first}–{confirm.first + confirm.ids.length - 1}.</p>
          <Field label="Which ones printed correctly?" id="pqB">
            <select id="pqB" value={badFrom} onChange={(e) => setBadFrom(e.target.value)}>
              <option value="all">All of them</option>
              {confirm.ids.map((id, i) => <option key={id} value={id}>Everything before check {confirm.first + i} ({rows.find((c) => c.id === id)?.payee_name}) — reprint from there</option>)}
            </select>
          </Field>
          <p className="small muted">Checks that printed get their numbers in the register. The rest stay in the queue so you can print them again.</p>
        </Modal>
      )}
    </>
  );
}

// ======================= write a check =======================
function WriteCheck({ ctx, accts, onSaved }: { ctx: Ctx; accts: BankAcct[]; onSaved: (queued: boolean) => void }) {
  const lk = useLookups(ctx);
  const [f, setF] = useState({ bank: accts[0].id, vendor: "", payee: "", address: "", date: todayIn(), later: true, number: "", memo: "",
    lines: [{ account_id: "", memo: "", amount: "" }] as { account_id: string; memo: string; amount: string }[] });
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const acct = accts.find((a) => a.id === f.bank)!;
  const gl = glPick(lk.data?.gl, acct.hotel_id);
  const vendors = (lk.data?.vendors || []).filter((v) => v.status === "active");
  const total = f.lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const setLine = (i: number, patch: Partial<(typeof f.lines)[0]>) => setF({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const lines = f.lines.filter((l) => l.account_id || Number(l.amount));
      if (!lines.length) throw new Error("Add at least one line with an account and amount.");
      if (lines.some((l) => !l.account_id || !(Number(l.amount) > 0))) throw new Error("Every line needs an account and an amount above zero.");
      if (!f.later && !/^\d{1,8}$/.test(f.number)) throw new Error("Enter the check number you wrote by hand (or tick “Print later”).");
      await db.rpc("write_check", { p_bank: f.bank, p_date: f.date, p_vendor: f.vendor || null, p_payee: f.payee.trim() || null, p_address: f.address.trim() || null,
        p_memo: f.memo.trim() || null, p_lines: lines.map((l) => ({ account_id: l.account_id, amount: Math.round(Number(l.amount) * 100) / 100, memo: l.memo.trim() || null })),
        p_number: f.later ? null : Number(f.number) });
      onSaved(f.later);
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={save}>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <Card>
        <div className="fgrid">
          <Field label="Bank account" id="wcB"><select id="wcB" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value, lines: f.lines.map((l) => ({ ...l, account_id: "" })) })}>
            {accts.map((a) => <option key={a.id} value={a.id}>{a.name} ••{a.last4} · {ctx.hotels.find((h) => h.id === a.hotel_id)?.name}</option>)}</select></Field>
          <Field label="Payee (vendor)" id="wcV"><select id="wcV" value={f.vendor} onChange={(e) => {
            const v = vendors.find((x) => x.id === e.target.value);
            const def = v?.default_gl ? gl.find((g) => g.id === v.default_gl || g.template_id === v.default_gl)?.id || "" : "";
            setF({ ...f, vendor: e.target.value, payee: v?.name || f.payee, address: v?.address || "", lines: f.lines.length === 1 && !f.lines[0].account_id ? [{ ...f.lines[0], account_id: def }] : f.lines });
          }}><option value="">Someone else (type the name)</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
          <Field label="Pay to the order of" id="wcP"><input id="wcP" required maxLength={120} value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} /></Field>
          <Field label="Date" id="wcD"><input id="wcD" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Mailing address (prints in the envelope window)" id="wcA" span><textarea id="wcA" rows={3} maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Memo" id="wcM"><input id="wcM" maxLength={120} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
          <div className="field"><span>Check number</span>
            <label className="check-row" htmlFor="wcL"><input id="wcL" type="checkbox" checked={f.later} onChange={(e) => setF({ ...f, later: e.target.checked })} /> Print later (adds it to the print queue)</label>
            {!f.later && <input aria-label="Hand-written check number" inputMode="numeric" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value.replace(/\D/g, "") })} placeholder={String(acct.next_check_number || 1001)} />}
          </div>
        </div>
      </Card>
      <div className="sp" />
      <Card title="Expense lines" flush>
        <div className="tw"><table>
          <thead><tr><th>#</th><th>Category (account)</th><th>Description</th><th className="n">Amount</th><th /></tr></thead>
          <tbody>{f.lines.map((l, i) => (
            <tr key={i}>
              <td className="small">{i + 1}</td>
              <td><select aria-label={`Line ${i + 1} account`} value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })} style={{ minWidth: 280 }}><option value="">Choose account…</option>{gl.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select></td>
              <td><input aria-label={`Line ${i + 1} description`} maxLength={200} value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} style={{ width: "100%" }} /></td>
              <td className="n"><input aria-label={`Line ${i + 1} amount`} inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value.replace(/[^\d.]/g, "") })} style={{ width: 120, textAlign: "right" }} /></td>
              <td>{f.lines.length > 1 && <button type="button" className="btn sm" aria-label="Remove line" onClick={() => setF({ ...f, lines: f.lines.filter((_, k) => k !== i) })}>✕</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="toolbar" style={{ padding: "10px 16px", margin: 0 }}>
          {f.lines.length < 30 && <button type="button" className="link" onClick={() => setF({ ...f, lines: [...f.lines, { account_id: "", memo: "", amount: "" }] })}>+ Add a line</button>}
          <span className="grow" /><span>Total <b className="num">{usd(total, 2)}</b></span>
        </div>
      </Card>
      {total > 0 && <p className="small muted">{amountInWords(total)} dollars</p>}
      <div className="acts" style={{ marginTop: 12 }}><button className="btn pri" disabled={busy}>{f.later ? "Save to the print queue" : "Save hand-written check"}</button></div>
    </form>
  );
}

// ======================= register =======================
function AllChecks({ ctx, accts }: { ctx: Ctx; accts: BankAcct[] }) {
  const canWrite = ctx.can("finance", "approve");
  const [acctId, setAcctId] = useState("");
  const [status, setStatus] = useState("");
  const [qs, setQs] = useState("");
  const q = useAsync(() => db.getAll<Check>(`checks?select=*&tenant_id=eq.${ctx.tenant.id}${acctId ? `&bank_account_id=eq.${acctId}` : ""}${status ? `&status=eq.${status}` : ""}&order=check_date.desc,check_number.desc.nullslast,id.asc`, 5000), [acctId, status]);
  const lk = useLookups(ctx);
  const companies = useCompanies(ctx);
  const [voiding, setVoiding] = useState<{ c: Check; reason: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const acctOf = (id: string) => accts.find((a) => a.id === id);
  const rows = useMemo(() => (q.data || []).filter((c) => !qs.trim() || `${c.payee_name} ${c.check_number || ""} ${c.memo || ""} ${Number(c.amount).toFixed(2)}`.toLowerCase().includes(qs.trim().toLowerCase())), [q.data, qs]);
  const glName = (id: string) => glLabel((lk.data?.gl || []).find((g) => g.id === id));
  async function act(f: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ kind: "good", text: ok }); setVoiding(null); q.reload(); } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function copy(c: Check) {
    const a = acctOf(c.bank_account_id)!;
    const pdf = await buildChecksPdf(await toPrintChecks([c], a, null, glName), { layout: a.check_layout || "voucher_top", offsetX: Number(a.check_offset_x || 0), offsetY: Number(a.check_offset_y || 0),
      company: a.check_print_company !== false && companies.data ? companies.data(a.hotel_id) : null });
    openPdf(pdf, `check-${c.check_number || "draft"}.pdf`);
  }
  return (
    <>
      <div className="toolbar">
        <select aria-label="Bank account" value={acctId} onChange={(e) => setAcctId(e.target.value)}><option value="">All bank accounts</option>{accts.map((a) => <option key={a.id} value={a.id}>{a.name} ••{a.last4}</option>)}</select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option value="to_print">To print</option><option value="printed">Printed</option><option value="voided">Void</option></select>
        <input type="search" aria-label="Search" placeholder="Payee, number, amount…" value={qs} onChange={(e) => setQs(e.target.value)} />
        <span className="grow" />
        <button className="btn sm" disabled={!rows.length} onClick={() => downloadFile(`checks-${todayIn()}.csv`, "﻿" + toCsv([["Number", "Date", "Payee", "Amount", "Memo", "Bank account", "Status"],
          ...rows.map((c) => [c.check_number, c.check_date, c.payee_name, Number(c.amount).toFixed(2), c.memo, acctOf(c.bank_account_id)?.name, STATUS[c.status][0]])]))}>Export</button>
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <Card flush>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : !rows.length ? <Empty title="No checks yet." /> : (
          <div className="tw"><table>
            <thead><tr><th>No.</th><th>Date</th><th>Payee</th><th>Bank account</th><th className="n">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className={c.status === "voided" ? "muted" : ""}>
                <td className="num"><b>{c.check_number ?? "—"}</b></td>
                <td className="small nowrap">{fmtDate(c.check_date)}</td>
                <td><b>{c.payee_name}</b>{c.memo && <div className="tag">{c.memo}</div>}{c.void_reason && <div className="tag">Void: {c.void_reason}</div>}</td>
                <td className="small">{acctOf(c.bank_account_id)?.name}</td>
                <td className="n">{usd(Number(c.amount), 2)}</td>
                <td><Pill kind={STATUS[c.status][1]}>{STATUS[c.status][0]}</Pill></td>
                <td className="nowrap">
                  {c.status !== "voided" && <button className="btn sm" onClick={() => copy(c).catch((e) => setMsg({ kind: "bad", text: e.message }))}>PDF</button>}{" "}
                  {canWrite && c.status === "printed" && <button className="btn sm" disabled={busy} onClick={() => act(() => db.rpc("requeue_checks", { p_ids: [c.id] }), "Back in the print queue (it will get a new number).")}>Reprint</button>}{" "}
                  {canWrite && c.status !== "voided" && <button className="btn sm danger" onClick={() => setVoiding({ c, reason: "" })}>Void</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {voiding && (
        <Modal title={`Void check ${voiding.c.check_number ?? ""} · ${usd(Number(voiding.c.amount), 2)}`} onClose={() => setVoiding(null)}
          onSubmit={(e) => { e.preventDefault(); return act(() => db.rpc("void_check", { p_id: voiding.c.id, p_reason: voiding.reason }), "Check voided. Its entry was reversed in the books" + (voiding.c.bill_ids?.length ? " and the bills are unpaid again." : ".")); }}
          footer={<><button type="button" className="btn" onClick={() => setVoiding(null)}>Cancel</button><button className="btn danger" disabled={busy}>Void check</button></>}>
          <p style={{ marginTop: 0 }}>{voiding.c.payee_name} · {fmtDate(voiding.c.check_date)}. {voiding.c.bill_ids?.length ? "The bills it paid go back to approved (unpaid)." : "The expense entry is reversed."}</p>
          <Field label="Reason" id="vcR"><input id="vcR" required maxLength={300} value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} placeholder="e.g. Lost in the mail, reissued" /></Field>
        </Modal>
      )}
    </>
  );
}

// ======================= printer setup =======================
function Setup({ ctx, accts, onSaved }: { ctx: Ctx; accts: BankAcct[]; onSaved: () => void }) {
  const [acctId, setAcctId] = useState(accts[0].id);
  const a = accts.find((x) => x.id === acctId)!;
  const [f, setF] = useState(() => ({ layout: a.check_layout || "voucher_top", x: String(a.check_offset_x ?? 0), y: String(a.check_offset_y ?? 0), next: String(a.next_check_number ?? 1001), company: a.check_print_company !== false }));
  const companies = useCompanies(ctx);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const pick = (id: string) => { const b = accts.find((x) => x.id === id)!; setAcctId(id); setF({ layout: b.check_layout || "voucher_top", x: String(b.check_offset_x ?? 0), y: String(b.check_offset_y ?? 0), next: String(b.next_check_number ?? 1001), company: b.check_print_company !== false }); };
  const valid = Math.abs(Number(f.x)) <= 1 && Math.abs(Number(f.y)) <= 1 && /^\d{1,8}$/.test(f.next);
  async function save() {
    try {
      if (!valid) throw new Error("Offsets must be between -1 and 1 inch, and the next number a whole number.");
      await db.update("bank_accounts", `id=eq.${a.id}`, { check_layout: f.layout, check_offset_x: Number(f.x), check_offset_y: Number(f.y), next_check_number: Number(f.next), check_print_company: f.company }, "id");
      setMsg({ kind: "good", text: "Saved." }); onSaved();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  async function test() {
    const pdf = await buildChecksPdf([SAMPLE_CHECK, SAMPLE_CHECK, SAMPLE_CHECK], { layout: f.layout as CheckLayout, offsetX: Number(f.x) || 0, offsetY: Number(f.y) || 0, company: f.company && companies.data ? companies.data(a.hotel_id) : null, sample: true });
    openPdf(pdf, "check-alignment-test.pdf");
  }
  return (
    <>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <Card>
        <div className="fgrid">
          <Field label="Bank account" id="psB"><select id="psB" value={acctId} onChange={(e) => pick(e.target.value)}>{accts.map((x) => <option key={x.id} value={x.id}>{x.name} ••{x.last4}</option>)}</select></Field>
          <Field label="Next check number" id="psN"><input id="psN" inputMode="numeric" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Move everything right (inches, − = left)" id="psX"><input id="psX" type="number" step="0.01" min="-1" max="1" value={f.x} onChange={(e) => setF({ ...f, x: e.target.value })} /></Field>
          <Field label="Move everything down (inches, − = up)" id="psY"><input id="psY" type="number" step="0.01" min="-1" max="1" value={f.y} onChange={(e) => setF({ ...f, y: e.target.value })} /></Field>
        </div>
        <div className="sp" />
        <div className="layouts" role="radiogroup" aria-label="Check stock">
          {(Object.keys(LAYOUT_LABEL) as CheckLayout[]).map((k) => (
            <label key={k} className={"layout" + (f.layout === k ? " on" : "")} htmlFor={"lay" + k}>
              <input id={"lay" + k} type="radio" name="layout" checked={f.layout === k} onChange={() => setF({ ...f, layout: k })} />
              <span className="sheet">{(k === "voucher_top" ? ["c", "s", "s"] : k === "voucher_middle" ? ["s", "c", "s"] : k === "voucher_bottom" ? ["s", "s", "c"] : ["c", "c", "c"]).map((p, i) => <i key={i} className={p === "c" ? "chk" : "stub"}>{p === "c" ? "Check" : "Stub"}</i>)}</span>
              <span className="small">{LAYOUT_LABEL[k]}</span>
            </label>
          ))}
        </div>
        <div className="sp" />
        <label className="check-row" htmlFor="psC"><input id="psC" type="checkbox" checked={f.company} onChange={(e) => setF({ ...f, company: e.target.checked })} /> Print the company name and address on the check (turn off if your stock already has it)</label>
        <div className="acts" style={{ marginTop: 14 }}>
          <button className="btn pri" onClick={save} disabled={!valid}>Save</button>
          <button className="btn" onClick={() => test().catch((e) => setMsg({ kind: "bad", text: e.message }))}>Print alignment test</button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>Print the alignment test on plain paper at “Actual size”, hold it over a blank check against the light, and nudge the offsets until the date, payee and amount sit on the lines. Bank account and routing numbers are never printed — they're already on your check stock.</p>
      </Card>
    </>
  );
}
