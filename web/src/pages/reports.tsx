import React, { useRef, useState } from "react";
import { db, storage, currentSession, callFunction } from "../lib/sb";
import { Ctx, REPORT_LABEL, guessReportType, yesterday, fmtDate, todayIn, appName } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Notice, HotelSelect, Modal, Field } from "../ui";
import { readReport } from "./intelligence";
import { readEml } from "../lib/eml";

const statusKind = (s: string) =>
  s === "processed" ? "good" : s === "needs_review" ? "warn" : s === "failed" ? "bad" : s === "superseded" ? "mute" : "info";
const sanitize = (n: string) => n.replace(/[^\w.\- ]+/g, "_");
const dateFromSubject = (s: string) => {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

// ======================= Report Inbox =======================
export function Reports({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const canUpload = ctx.can("reports", "edit");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const [date, setDate] = useState(yesterday());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useAsync(async () => {
    const [rows, missing, mails, hotels] = await Promise.all([
      db.get<any>(`reports?select=id,hotel_id,report_type,business_date,file_name,file_path,file_format,source,status,confidence,received_at,extracted,extracted_notes&tenant_id=eq.${ctx.tenant.id}&order=received_at.desc&limit=80`),
      db.rpc<any[]>("missing_reports", { p_date: yesterday() }),
      db.get<any>(`inbound_emails?select=*&tenant_id=eq.${ctx.tenant.id}&order=received_at.desc&limit=20`).catch(() => []),
      db.get<any>(`hotels?select=id,name,city,report_email,property_code,status&tenant_id=eq.${ctx.tenant.id}&order=name.asc`),
    ]);
    return { rows, missing, mails, hotels };
  }, [ctx.tenant.id]);
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "—";
  const rooms = (id: string) => ctx.hotels.find((h) => h.id === id)?.rooms || 0;

  async function storeAndRead(f: File, hid: string, bdate: string, source: string) {
    const ext = (f.name.split(".").pop() || "").toUpperCase();
    const path = `${ctx.tenant.id}/${hid}/${bdate}/${Date.now()}-${sanitize(f.name)}`;
    await storage.upload("reports", path, f);
    const type = guessReportType(f.name);
    const [rep] = await db.insert<any>("reports", { tenant_id: ctx.tenant.id, hotel_id: hid, report_type: type, business_date: bdate, file_name: f.name, file_path: path,
      file_format: ext, source, status: "received", uploaded_by: currentSession()?.user.id }, "id");
    try { return await readReport(f, rep.id, rooms(hid), bdate, type); }
    catch (e: any) { return { status: "stored", note: `Stored; couldn't read it (${e.message}).`, date: bdate }; }
  }
  async function upload(files: FileList | File[]) {
    if (!hotelId) return;
    setBusy(true); setMsg(null);
    const notes: string[] = [];
    let n = 0;
    try {
      for (const f of Array.from(files)) {
        if (/\.eml$/i.test(f.name)) {
          // a saved email (e.g. last night's report email): read every attachment, skip duplicates
          const e = await readEml(f);
          const bdate = dateFromSubject(e.subject) || date;
          const seen = new Set<string>();
          for (const p of e.parts.filter((x) => x.filename)) {
            const key = `${p.bytes.length}:${p.bytes.slice(0, 64).join(",")}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const file = new File([p.bytes as BlobPart], p.filename!, { type: p.type });
            const r = await storeAndRead(file, hotelId, bdate, "email");
            notes.push(`${p.filename}: ${r.note}`); n++;
          }
        } else {
          const r = await storeAndRead(f, hotelId, date, "upload");
          notes.push(`${f.name}: ${r.note}`); n++;
        }
      }
      setMsg({ kind: "good", text: `${n} file${n === 1 ? "" : "s"} saved. ${notes.join(" ")}` });
      q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: `Stopped after ${n}: ${e.message}` }); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function copy(t: string) { try { await navigator.clipboard.writeText(t); setMsg({ kind: "info", text: `Copied ${t}` }); } catch { /* ignore */ } }
  const lastFor = (hid: string) => q.data?.rows.find((r: any) => r.hotel_id === hid && r.source === "email");

  return (
    <>
      <PageHead eyebrow="Data" title="Report Inbox" desc="Every hotel's PMS emails its night audit here automatically. Reports are stored, read in seconds, and the morning snapshot goes out." />
      {msg && <Notice kind={msg.kind === "info" ? "info" : msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <>
          <Card title="Where hotels send their nightly reports" note="One address for every hotel. The hotel is recognised from the report itself.">
            {ctx.tenant.report_inbox ? (
              <p>Point each hotel's scheduled PMS reports (or your HelloGM email) to <code className="addr">{ctx.tenant.report_inbox}</code>{" "}
                <button className="btn sm" onClick={() => copy(ctx.tenant.report_inbox!)}>Copy</button></p>
            ) : <p className="muted">No report inbox is set up for this company yet.</p>}
            <div className="tw"><table>
              <thead><tr><th>Hotel</th><th>Recognised by</th><th>Last report by email</th></tr></thead>
              <tbody>{q.data.hotels.filter((h: any) => h.status === "operating").map((h: any) => {
                const last = lastFor(h.id);
                return (
                  <tr key={h.id}>
                    <td><b>{h.name}</b><div className="tag">{h.city}</div></td>
                    <td className="small">{h.property_code ? <>Property code <code>{h.property_code}</code> on the night audit or in the subject</>
                      : <>Its name in the email subject <span className="muted">(add the property code under Setup → Hotels for automatic matching)</span></>}</td>
                    <td className="small">{last ? <>{fmtDate(last.business_date)} · <Pill kind={statusKind(last.status) as any}>{last.status.replace("_", " ")}</Pill></> : <span className="muted">Nothing yet</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </Card>
          <div className="sp" />
        </>
      )}
      {canUpload && (
        <Card title="Upload reports or a saved report email">
          <div className="fgrid" style={{ marginBottom: 14 }}>
            <Field label="Hotel" id="upHotel"><HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} id="upHotel" /></Field>
            <Field label="Business date" id="upDate" hint="Night audits set their own date automatically"><input id="upDate" type="date" value={date} max={todayIn()} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <div className={"drop" + (over ? " over" : "")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}>
            <b>{busy ? "Reading…" : "Drop reports or .eml emails here"}</b>
            <span className="small muted">Hilton OnQ Final Audit is read exactly · PDF, Excel, CSV, TXT, XML, HTML, saved emails (.eml) · up to 50 MB</span>
            <label className="btn" htmlFor="upFile">Choose files</label>
            <input id="upFile" ref={fileRef} type="file" multiple hidden disabled={busy} onChange={(e) => e.target.files && e.target.files.length && upload(e.target.files)} />
          </div>
        </Card>
      )}
      <div className="sp" />
      {q.data && (
        <div className="grid g-2-1">
          <Card title="Recent reports" flush>
            {q.data.rows.length ? (
              <div className="tw"><table>
                <thead><tr><th>File</th><th>Hotel</th><th>Report</th><th>Date</th><th>From</th><th>Status</th><th></th></tr></thead>
                <tbody>{q.data.rows.map((r: any) => (
                  <tr key={r.id}>
                    <td><span className="small">{r.file_name}</span> <span className="chip">{r.file_format}</span></td>
                    <td className="nowrap small">{hName(r.hotel_id)}</td>
                    <td className="small">{REPORT_LABEL[r.report_type] || r.report_type}</td>
                    <td className="nowrap small">{r.business_date ? fmtDate(r.business_date) : "—"}</td>
                    <td className="small">{r.source}</td>
                    <td><Pill kind={statusKind(r.status) as any}>{r.status.replace("_", " ")}</Pill></td>
                    <td><div className="row-actions">
                      {r.extracted && <button className="btn sm" onClick={() => setDetail(r)}>Figures</button>}
                      {r.file_path && <button className="btn sm" onClick={async () => window.open(await storage.signedUrl("reports", r.file_path, 120), "_blank", "noopener")}>Open</button>}
                    </div></td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty title="No reports yet.">Once the PMS emails start arriving, every report appears here.</Empty>}
          </Card>
          <div className="grid" style={{ alignContent: "start" }}>
            <Card title={`Missing for ${fmtDate(yesterday())}`} flush>
              {q.data.missing.length ? (
                <div className="list">{q.data.missing.map((m: any, i: number) => (
                  <div className="li" key={i}><span className="stripe" style={{ background: "var(--bad)" }} />
                    <div><div className="t">{REPORT_LABEL[m.report_type]}</div><div className="s">{hName(m.hotel_id)}</div></div></div>
                ))}</div>
              ) : <Empty title="All required reports are in." />}
            </Card>
            <Card title="Report emails received" flush>
              {q.data.mails.length ? (
                <div className="list">{q.data.mails.map((m: any) => (
                  <div className="li" key={m.id}>
                    <span className="stripe" style={{ background: m.status === "processed" ? "var(--good)" : m.status === "partial" ? "var(--warn)" : "var(--bad)" }} />
                    <div style={{ minWidth: 0 }}><div className="t small">{m.subject || "(no subject)"}</div>
                      <div className="s">{new Date(m.received_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · {m.hotel_id ? hName(m.hotel_id) : "no matching hotel"} · {m.reports_created} file{m.reports_created === 1 ? "" : "s"}</div>
                      {m.detail && <div className="s" style={{ marginTop: 2 }}>{m.detail}</div>}</div>
                  </div>
                ))}</div>
              ) : <Empty title="No report emails yet." />}
            </Card>
          </div>
        </div>
      )}
      {detail && (
        <Modal title={`${detail.file_name}`} onClose={() => setDetail(null)} wide footer={<button className="btn" onClick={() => setDetail(null)}>Close</button>}>
          <p className="small muted" style={{ marginTop: 0 }}>{hName(detail.hotel_id)} · {fmtDate(detail.business_date)} · {detail.extracted?.extra?.format || "general reader"}</p>
          <div className="tw"><table><tbody>
            {Object.entries(detail.extracted?.values || {}).map(([k, v]) => <tr key={k}><td className="small">{k.replace(/_/g, " ")}</td><td className="n">{String(v)}</td></tr>)}
            {Object.entries(detail.extracted?.deposits || {}).map(([k, v]) => <tr key={k}><td className="small">payment · {k.replace("_", " ")}</td><td className="n">${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td></tr>)}
          </tbody></table></div>
          {(detail.extracted_notes || []).map((n: string) => <Notice key={n} kind="info">{n}</Notice>)}
        </Modal>
      )}
    </>
  );
}

// ======================= Nightly snapshot email =======================
export function Snapshot({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const canEdit = ctx.can("reports", "edit"), canAdmin = ctx.can("reports", "admin");
  const dates = useAsync(() => db.get<any>(`daily_metrics?select=business_date&hotel_id=eq.${hotelId}&order=business_date.desc&limit=30`), [hotelId]);
  const [date, setDate] = useState("");
  const d = date || dates.data?.[0]?.business_date || "";
  const prev = useAsync(async () => (d ? callFunction<any>("daily-snapshot", { action: "preview", hotel_id: hotelId, date: d, portal: location.origin }) : null), [hotelId, d]);
  const rec = useAsync(() => db.get<any>(`snapshot_recipients?select=*&tenant_id=eq.${ctx.tenant.id}&order=email.asc`), []);
  const sends = useAsync(() => db.get<any>(`snapshot_sends?select=*&tenant_id=eq.${ctx.tenant.id}&order=sent_at.desc&limit=15`), [hotelId]);
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<"hotel" | "all">("hotel");
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await db.insert("snapshot_recipients", { tenant_id: ctx.tenant.id, hotel_id: scope === "all" ? null : hotelId, email: email.trim().toLowerCase() }, "id");
      setEmail(""); rec.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: /duplicate/.test(err.message) ? "That address is already on the list." : err.message }); }
  }
  async function send(action: "test" | "send") {
    setBusy(true); setMsg(null);
    try {
      const r = await callFunction<any>("daily-snapshot", { action, hotel_id: hotelId, date: d, portal: location.origin });
      setMsg(r.error ? { kind: "bad", text: r.error } : { kind: "good", text: action === "test" ? `Test sent to ${currentSession()?.user.email}.` : `Sent to ${r.sent} recipient${r.sent === 1 ? "" : "s"}.${r.note ? " " + r.note : ""}` });
      sends.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  const list = (rec.data || []).filter((r: any) => r.hotel_id === hotelId || r.hotel_id === null);
  return (
    <>
      <PageHead eyebrow="Data" title="Nightly Snapshot Email" desc={`After each hotel's night audit arrives, ${appName()} emails a one-page summary — day, month and year against last year, budget, segments and payments — to the people you choose.`}
        actions={canEdit && d && <><button className="btn" disabled={busy} onClick={() => send("test")}>Send test to me</button><button className="btn pri" disabled={busy || !list.length} onClick={() => send("send")}>Send now</button></>} />
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={(v) => { setHotelId(v); setDate(""); }} />
        <select aria-label="Business date" value={d} onChange={(e) => setDate(e.target.value)} disabled={!dates.data?.length}>
          {(dates.data || []).map((x: any) => <option key={x.business_date} value={x.business_date}>{fmtDate(x.business_date)}</option>)}
        </select>
      </div>
      {msg && <Notice kind={msg.kind === "info" ? "info" : msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <div className="grid g-2-1">
        <Card title="Preview" flush>
          {!d ? <Empty title="No night audit for this hotel yet.">The preview appears as soon as the first report is read (upload last night's report email on Report Inbox to try it).</Empty>
            : prev.loading ? <Loading /> : prev.error ? <ErrorBox error={prev.error} retry={prev.reload} />
            : prev.data?.html ? <iframe title="Snapshot preview" className="snap-frame" srcDoc={prev.data.html} sandbox="" /> : <Empty title={prev.data?.error || "Nothing to show."} />}
        </Card>
        <div className="grid" style={{ alignContent: "start" }}>
          <Card title="Who receives it">
            {list.length ? (
              <div className="list" style={{ marginBottom: 10 }}>{list.map((r: any) => (
                <div className="li" key={r.id} style={{ padding: "8px 0", alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}><div className="t small">{r.email}</div><div className="s">{r.hotel_id ? "This hotel" : "Every hotel"}</div></div>
                  {canAdmin && <div className="r"><button className="btn sm" onClick={async () => { await db.remove("snapshot_recipients", `id=eq.${r.id}`).catch((e) => setMsg({ kind: "bad", text: e.message })); rec.reload(); }}>Remove</button></div>}
                </div>
              ))}</div>
            ) : <p className="small muted" style={{ marginTop: 0 }}>Nobody yet — add the GM, owners and your team.</p>}
            {canAdmin && (
              <form onSubmit={add} className="stack">
                <Field label="Email" id="snapEmail"><input id="snapEmail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@akeahms.com" /></Field>
                <label className="check-row" htmlFor="snapAll"><input id="snapAll" type="checkbox" checked={scope === "all"} onChange={(e) => setScope(e.target.checked ? "all" : "hotel")} /> Send every hotel's snapshot to this person</label>
                <button className="btn">Add recipient</button>
              </form>
            )}
          </Card>
          <Card title="Recent sends" flush>
            {(sends.data || []).length ? <div className="list">{sends.data!.map((s: any) => (
              <div className="li" key={s.id} style={{ padding: "9px 18px" }}>
                <span className="stripe" style={{ background: s.status === "sent" ? "var(--good)" : s.status === "skipped" ? "var(--warn)" : "var(--bad)" }} />
                <div style={{ minWidth: 0 }}><div className="t small">{ctx.hotels.find((h) => h.id === s.hotel_id)?.name} · {fmtDate(s.business_date)}</div>
                  <div className="s">{new Date(s.sent_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · {s.status} · {s.detail}</div></div>
              </div>
            ))}</div> : <Empty title="Nothing sent yet." />}
          </Card>
        </div>
      </div>
    </>
  );
}
