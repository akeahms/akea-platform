// Refunds: guest and deposit refunds are requested by the hotel, approved only by a Principal (super admin), then paid
// (which posts the journal entry). Everything goes through database functions that enforce those rules.
import React, { useState } from "react";
import { db, currentSession } from "../lib/sb";
import { Ctx, usd, fmtDate, todayIn } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, Notice, HotelSelect, Tabs } from "../ui";

type Refund = { id: string; hotel_id: string; kind: "guest" | "deposit"; guest_name: string; reference: string | null; amount: number; method: string; reason: string;
  status: "requested" | "approved" | "rejected" | "paid" | "cancelled"; requested_by: string; requested_at: string; decided_at: string | null; decision_note: string | null;
  paid_at: string | null; paid_ref: string | null };
const STATUS: Record<Refund["status"], [string, "warn" | "info" | "good" | "bad" | "mute"]> = {
  requested: ["Waiting for Principal", "warn"], approved: ["Approved · to pay", "info"], paid: ["Paid", "good"], rejected: ["Rejected", "bad"], cancelled: ["Withdrawn", "mute"],
};
const METHOD: Record<string, string> = { original_card: "Back to the original card", check: "Check", ach: "ACH", cash: "Cash" };

export function Refunds({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState("");
  const [tab, setTab] = useState<"open" | "all">("open");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const [decide, setDecide] = useState<{ r: Refund; approve: boolean; note: string } | null>(null);
  const [pay, setPay] = useState<{ r: Refund; date: string; ref: string } | null>(null);
  const isPrincipal = useAsync(() => db.rpc<boolean>("is_principal", { p_tenant: ctx.tenant.id }), [ctx.tenant.id]);
  const canRequest = ctx.can("finance", "edit"), canPay = ctx.can("finance", "approve") || !!isPrincipal.data;
  const q = useAsync(() => db.getAll<Refund>(`refund_requests?select=*&tenant_id=eq.${ctx.tenant.id}${hotelId ? `&hotel_id=eq.${hotelId}` : ""}&order=requested_at.desc,id.asc`, 5000), [hotelId]);
  const rows = (q.data || []).filter((r) => tab === "all" || r.status === "requested" || r.status === "approved");
  const waiting = (q.data || []).filter((r) => r.status === "requested");
  const hotel = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";
  const me = currentSession()?.user.id;

  async function act(f: () => Promise<unknown>, text: string) {
    try { await f(); setMsg({ kind: "good", text }); setForm(null); setDecide(null); setPay(null); q.reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  return (
    <>
      <PageHead eyebrow="Finance" title="Refunds" desc="Guest and deposit refunds. Anyone with finance edit rights can request one; only a Principal can approve it; then it's paid and recorded in the hotel's books."
        actions={canRequest ? <button className="btn pri" onClick={() => setForm({ hotel_id: hotelId || operating[0]?.id, kind: "guest", guest: "", reference: "", amount: "", method: "original_card", reason: "" })}>Request a refund</button> : undefined} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {isPrincipal.data && waiting.length > 0 && <Notice kind="info">{waiting.length} refund{waiting.length === 1 ? " is" : "s are"} waiting for your approval.</Notice>}
      {!isPrincipal.data && isPrincipal.data !== undefined && <p className="small muted">Approvals are done by a Principal (super admin). You'll see the decision here.</p>}
      <div className="toolbar"><HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} all /><Tabs value={tab} onChange={setTab} tabs={[["open", "Open"], ["all", "All"]]} /></div>
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.loading && !q.data ? <Loading /> : (
        <Card flush>
          {!rows.length ? <Empty title={tab === "open" ? "No open refunds." : "No refunds yet."} /> : (
            <div className="tw"><table>
              <thead><tr><th>Requested</th><th>Hotel</th><th>Guest</th><th>Reason</th><th className="num">Amount</th><th>How</th><th>Status</th><th /></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap small">{fmtDate(r.requested_at.slice(0, 10))}</td>
                  <td className="small">{hotel(r.hotel_id)}</td>
                  <td><b>{r.guest_name}</b><div className="small muted">{r.kind === "deposit" ? "Deposit / advance" : "Guest refund"}{r.reference ? ` · ${r.reference}` : ""}</div></td>
                  <td className="small" style={{ maxWidth: 360 }}>{r.reason}{r.decision_note && <div className="muted">Note: {r.decision_note}</div>}</td>
                  <td className="num"><b>{usd(Number(r.amount), 2)}</b></td>
                  <td className="small">{METHOD[r.method]}{r.paid_ref ? ` · ${r.paid_ref}` : ""}</td>
                  <td><Pill kind={STATUS[r.status][1]}>{STATUS[r.status][0]}</Pill>{r.paid_at && <div className="small muted">{fmtDate(r.paid_at)}</div>}</td>
                  <td className="nowrap">
                    {r.status === "requested" && isPrincipal.data && <>
                      <button className="btn sm" onClick={() => setDecide({ r, approve: false, note: "" })}>Reject</button>{" "}
                      <button className="btn sm pri" onClick={() => setDecide({ r, approve: true, note: "" })}>Approve</button>{" "}</>}
                    {r.status === "requested" && (r.requested_by === me || isPrincipal.data) &&
                      <button className="btn sm" onClick={() => act(() => db.rpc("cancel_refund", { p_id: r.id }), "Request withdrawn.")}>Withdraw</button>}
                    {r.status === "approved" && canPay && <button className="btn sm pri" onClick={() => setPay({ r, date: todayIn(), ref: "" })}>Record as paid</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}
      {form && (
        <Modal title="Request a refund" onClose={() => setForm(null)} onSubmit={async (e) => { e.preventDefault();
          await act(() => db.rpc("request_refund", { p_hotel: form.hotel_id, p_kind: form.kind, p_guest: form.guest, p_reference: form.reference, p_amount: Number(form.amount), p_method: form.method, p_reason: form.reason }),
            "Refund requested. A Principal has been notified to approve it."); }}
          footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri">Send for approval</button></>}>
          <div className="fgrid">
            <Field label="Hotel" id="rfH"><HotelSelect hotels={operating} value={form.hotel_id} onChange={(v) => setForm({ ...form, hotel_id: v })} id="rfH" /></Field>
            <Field label="Type" id="rfK"><select id="rfK" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="guest">Guest refund</option><option value="deposit">Deposit / advance payment</option></select></Field>
            <Field label="Guest or group" id="rfG"><input id="rfG" required maxLength={150} value={form.guest} onChange={(e) => setForm({ ...form, guest: e.target.value })} /></Field>
            <Field label="Folio / confirmation #" id="rfR"><input id="rfR" maxLength={60} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
            <Field label="Amount" id="rfA"><input id="rfA" type="number" min="0.01" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            <Field label="Refund by" id="rfM"><select id="rfM" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Reason" id="rfW" span><textarea id="rfW" required rows={3} maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {decide && (
        <Modal title={`${decide.approve ? "Approve" : "Reject"} ${usd(Number(decide.r.amount), 2)} refund?`} onClose={() => setDecide(null)}
          onSubmit={async (e) => { e.preventDefault(); await act(() => db.rpc("decide_refund", { p_id: decide.r.id, p_approve: decide.approve, p_note: decide.note || null }), decide.approve ? "Refund approved. It can now be paid." : "Refund rejected."); }}
          footer={<><button type="button" className="btn" onClick={() => setDecide(null)}>Cancel</button><button className={"btn " + (decide.approve ? "pri" : "danger")}>{decide.approve ? "Approve" : "Reject"}</button></>}>
          <p><b>{decide.r.guest_name}</b> · {hotel(decide.r.hotel_id)}{decide.r.reference ? ` · ${decide.r.reference}` : ""}<br />{decide.r.reason}</p>
          <Field label="Note (optional)" id="rfN"><input id="rfN" maxLength={300} value={decide.note} onChange={(e) => setDecide({ ...decide, note: e.target.value })} /></Field>
        </Modal>
      )}
      {pay && (
        <Modal title={`Record ${usd(Number(pay.r.amount), 2)} refund as paid`} onClose={() => setPay(null)}
          onSubmit={async (e) => { e.preventDefault(); await act(() => db.rpc("pay_refund", { p_id: pay.r.id, p_date: pay.date, p_ref: pay.ref || null }), "Refund recorded and posted to the books."); }}
          footer={<><button type="button" className="btn" onClick={() => setPay(null)}>Cancel</button><button className="btn pri">Record as paid</button></>}>
          <p className="small muted">{METHOD[pay.r.method]}. This posts the refund to {hotel(pay.r.hotel_id)}'s books.</p>
          <div className="fgrid">
            <Field label="Date refunded" id="rfD"><input id="rfD" type="date" required max={todayIn()} value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
            <Field label="Reference (authorization, check #)" id="rfP"><input id="rfP" maxLength={60} value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
