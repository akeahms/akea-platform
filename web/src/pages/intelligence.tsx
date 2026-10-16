import React, { useEffect, useRef, useState } from "react";
import { callFunction, db } from "../lib/sb";
import { Ctx, todayIn, fmtDate, appName } from "../lib/app";
import { PageHead, Card, Loading, Notice, Field, useAsync, downloadFile } from "../ui";
import { documentText } from "../lib/parse";
import { extractReport } from "../lib/extract";

// ======================= Ask AI =======================
type Msg = { role: "user" | "assistant"; content: string; steps?: { tool: string; detail: string; rows: number }[]; error?: boolean };
const SUGGEST = [
  "How did occupancy and ADR compare to last year for each hotel this month?",
  "Which hotel had the highest RevPAR last week?",
  "Which bills are waiting for approval and how much is due this week?",
  "Who worked overtime last week?",
  "Which permits or insurance policies expire in the next 60 days?",
  "Show deposits that haven't arrived in the bank yet.",
];
export function AskAI({ ctx }: { ctx: Ctx }) {
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem("akea.ask") || "[]"); } catch { return []; }
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { sessionStorage.setItem("akea.ask", JSON.stringify(msgs.slice(-20))); } catch { /* ignore */ }
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs]);
  async function ask(text: string) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: "user" as const, content: text.trim() }];
    setMsgs(next); setQ(""); setBusy(true);
    try {
      const r = await callFunction<any>("ask-ai", { question: text.trim(), today: todayIn(), history: next.slice(0, -1).filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })) });
      setMsgs([...next, { role: "assistant", content: r.answer || r.error || "No answer.", steps: r.steps, error: !r.configured || !!r.error }]);
    } catch (e: any) {
      setMsgs([...next, { role: "assistant", content: `Sorry — ${e.message}`, error: true }]);
    } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead eyebrow="Intelligence" title="Ask AI" desc={`Ask anything about ${ctx.tenant.brand_name || ctx.tenant.name}'s hotels in plain English. Answers come from live data and only include what your role can see.`}
        actions={msgs.length > 0 && <button className="btn" onClick={() => setMsgs([])}>New conversation</button>} />
      <div className="chat">
        {!msgs.length && (
          <Card title="Try asking">
            <div className="suggest">{SUGGEST.map((s) => <button key={s} type="button" onClick={() => ask(s)}>{s}</button>)}</div>
          </Card>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={"msg " + (m.role === "user" ? "me" : "ai")} style={m.error ? { borderColor: "var(--warn)" } : undefined}>
            {m.content}
            {m.steps && m.steps.length > 0 && (
              <details className="src"><summary>Looked at {m.steps.length} data source{m.steps.length === 1 ? "" : "s"}</summary>
                <ul className="plain">{m.steps.map((s, j) => <li key={j}>{s.tool.replace(/_/g, " ")} · {s.rows} row{s.rows === 1 ? "" : "s"}</li>)}</ul></details>
            )}
          </div>
        ))}
        {busy && <div className="msg ai"><span className="muted">Looking through your data…</span></div>}
        <div ref={end} />
      </div>
      <form className="ask-box" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <textarea aria-label="Your question" placeholder="e.g. What was total revenue across all hotels yesterday?" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(q); } }} />
        <button className="btn pri" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </>
  );
}

// ======================= PDF form filler =======================
type FField = { name: string; type: "text" | "check" | "select" | "radio"; options?: string[]; value: string | boolean };
const MAP: [RegExp, string][] = [
  [/legal.*name|business.*name|company.*name|entity.*name|borrower.*name|applicant.*name/i, "entity.legal_name"],
  [/\bdba\b|doing\s*business/i, "entity.dba"],
  [/(business|entity|company).*(address|street)|street|address\s*1|^address$/i, "entity.physical_address"],
  [/mailing/i, "entity.mailing_address"],
  [/phone|telephone/i, "entity.phone"],
  [/e-?mail/i, "entity.email"],
  [/state.*(organization|formation|incorporation)/i, "entity.formation_state"],
  [/entity.*type|type.*entity|business.*type/i, "entity.entity_type"],
  [/hotel|property.*name/i, "hotel.name"],
  [/rooms|keys/i, "hotel.rooms"],
  [/^date$|date.*(signed|today|prepared)/i, "today"],
  [/cash.*(hand|bank)/i, "pfs.cash"], [/savings/i, "pfs.savings"], [/ira|retirement/i, "pfs.retirement"], [/accounts.*notes.*receivable|receivable/i, "pfs.receivables"],
  [/life.*insurance.*cash|cash.*surrender/i, "pfs.life_cash"], [/stocks|bonds/i, "pfs.securities"], [/automobile/i, "pfs.autos"], [/other.*personal.*property/i, "pfs.personal"],
  [/accounts.*payable/i, "pfs.payables"], [/notes.*payable/i, "pfs.notes_banks"], [/unpaid.*tax/i, "pfs.taxes"], [/salary/i, "pfs.salary"], [/net.*investment/i, "pfs.investment"], [/real.*estate.*income/i, "pfs.re_income"],
];
export function PdfFiller({ ctx }: { ctx: Ctx }) {
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState<FField[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [hotelId, setHotelId] = useState(ctx.hotels[0]?.id || "");
  const [flatten, setFlatten] = useState(false);
  const bytes = useRef<ArrayBuffer | null>(null);
  const src = useAsync(async () => {
    const h = ctx.hotels.find((x) => x.id === hotelId);
    const [ent, pfs] = await Promise.all([
      h?.entity_id ? db.get<any>(`entities?select=*&id=eq.${h.entity_id}`).catch(() => []) : Promise.resolve([]),
      db.get<any>(`pfs_statements?select=*&order=updated_at.desc&limit=1`).catch(() => []),
    ]);
    return { hotel: h, entity: ent[0] || null, pfs: pfs[0]?.data || null };
  }, [hotelId]);
  async function load(f: File) {
    setMsg(null); setFile(f);
    try {
      const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = await import("pdf-lib");
      bytes.current = await f.arrayBuffer();
      const doc = await PDFDocument.load(bytes.current, { ignoreEncryption: true });
      const form = doc.getForm();
      const out: FField[] = form.getFields().map((fl: any) => {
        const name = fl.getName();
        if (fl instanceof PDFTextField) return { name, type: "text", value: fl.getText() || "" };
        if (fl instanceof PDFCheckBox) return { name, type: "check", value: fl.isChecked() };
        if (fl instanceof PDFDropdown || fl instanceof PDFOptionList) return { name, type: "select", options: fl.getOptions(), value: (fl.getSelected() || [])[0] || "" };
        if (fl instanceof PDFRadioGroup) return { name, type: "radio", options: fl.getOptions(), value: fl.getSelected() || "" };
        return null as any;
      }).filter(Boolean);
      setFields(out);
      setMsg(out.length ? { kind: "info", text: `${out.length} fillable fields found. Use "Fill from my data", review, then download.` } : { kind: "bad", text: "This PDF has no fillable fields. Ask the sender for a fillable version, or print and sign it." });
    } catch (e: any) { setMsg({ kind: "bad", text: `Couldn't open this PDF: ${e.message}` }); setFields(null); }
  }
  function autofill() {
    if (!fields || !src.data) return;
    const d = src.data;
    const get = (path: string): string => {
      if (path === "today") return new Date().toLocaleDateString("en-US");
      const [obj, key] = path.split(".");
      const o: any = obj === "entity" ? d.entity : obj === "hotel" ? d.hotel : d.pfs;
      const v = o?.[key];
      return v == null || v === "" ? "" : String(v);
    };
    let n = 0;
    setFields(fields.map((f) => {
      if (f.type !== "text" || f.value) return f;
      const hit = MAP.find(([re]) => re.test(f.name.replace(/[_.\-\[\]0-9]+/g, " ")));
      const v = hit ? get(hit[1]) : "";
      if (v) { n++; return { ...f, value: v }; }
      return f;
    }));
    setMsg({ kind: n ? "good" : "info", text: n ? `Filled ${n} fields from company${d.pfs ? ", PFS" : ""} and hotel records. Check every value before you sign.` : "No fields matched your saved data — fill them in by hand." });
  }
  async function download() {
    if (!bytes.current || !fields || !file) return;
    try {
      const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = await import("pdf-lib");
      const doc = await PDFDocument.load(bytes.current, { ignoreEncryption: true });
      const form = doc.getForm();
      for (const f of fields) {
        const fl: any = form.getField(f.name);
        try {
          if (fl instanceof PDFTextField) fl.setText(String(f.value || ""));
          else if (fl instanceof PDFCheckBox) f.value ? fl.check() : fl.uncheck();
          else if ((fl instanceof PDFDropdown || fl instanceof PDFOptionList) && f.value) fl.select(String(f.value));
          else if (fl instanceof PDFRadioGroup && f.value) fl.select(String(f.value));
        } catch { /* field with unusual formatting — leave as is */ }
      }
      if (flatten) form.flatten();
      const out = await doc.save();
      downloadFile(file.name.replace(/\.pdf$/i, "") + " - filled.pdf", out as BlobPart, "application/pdf");
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  const set = (i: number, v: string | boolean) => setFields(fields!.map((f, j) => (j === i ? { ...f, value: v } : f)));
  return (
    <>
      <PageHead eyebrow="Documents" title="PDF Form Filler" desc="Open any fillable PDF — bank, SBA, franchise, vendor or tax forms — fill it from your saved company, hotel and PFS records, and download. The file never leaves your browser."
        actions={fields && <><button className="btn" onClick={autofill}>Fill from my data</button><button className="btn pri" onClick={download}>Download filled PDF</button></>} />
      <div className="grid g-2-1">
        <div>
          {!fields ? (
            <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.dataTransfer.files[0] && load(e.dataTransfer.files[0]); }}>
              <b>Drop a fillable PDF form</b><span className="small muted">e.g. SBA Form 413, a bank's loan application, W-9</span>
              <label className="btn" htmlFor="pdfForm">Choose PDF</label>
              <input id="pdfForm" type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
            </div>
          ) : (
            <Card title={file?.name} actions={<button className="btn sm" onClick={() => { setFields(null); setFile(null); setMsg(null); }}>Choose another</button>}>
              {msg && <Notice kind={msg.kind === "info" ? "info" : msg.kind}>{msg.text}</Notice>}
              <div className="fgrid">{fields.map((f, i) => (
                <Field key={f.name + i} label={f.name} id={"ff" + i}>
                  {f.type === "text" && <input id={"ff" + i} value={String(f.value)} onChange={(e) => set(i, e.target.value)} />}
                  {f.type === "check" && <input id={"ff" + i} type="checkbox" checked={!!f.value} onChange={(e) => set(i, e.target.checked)} style={{ width: 22, height: 22 }} />}
                  {(f.type === "select" || f.type === "radio") && <select id={"ff" + i} value={String(f.value)} onChange={(e) => set(i, e.target.value)}><option value="">—</option>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>}
                </Field>
              ))}</div>
            </Card>
          )}
          {!fields && msg && <Notice kind={msg.kind === "info" ? "info" : msg.kind}>{msg.text}</Notice>}
        </div>
        <Card title="Fill using">
          <div className="stack">
            <Field label="Hotel & ownership entity" id="pfHotel"><select id="pfHotel" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>{ctx.hotels.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.city}</option>)}</select></Field>
            {src.loading ? <Loading /> : src.data && (
              <ul className="plain small">
                <li>Company: {src.data.entity?.legal_name || <span className="muted">not set up</span>}</li>
                <li>Personal financial statement: {src.data.pfs ? "saved" : <span className="muted">none yet</span>}</li>
              </ul>
            )}
            <label className="check-row" htmlFor="pfFlat"><input id="pfFlat" type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> Lock fields after filling (flatten)</label>
            <p className="small muted" style={{ margin: 0 }}>Full EIN and Social Security numbers are never stored in {appName()} — type them into the form yourself.</p>
          </div>
        </Card>
      </div>
    </>
  );
}

// ======================= Read an uploaded report into the day's numbers =======================
// Only a recognised night-audit layout (or a file named as a final audit that reads cleanly) changes the day's numbers.
export async function readReport(file: File, reportId: string, rooms: number, businessDate: string, typeHint = "unknown") {
  const t0 = performance.now();
  const { text } = await documentText(file);
  if (!text.trim()) return { status: "stored", note: "Stored (no readable text — a scanned image needs OCR).", date: businessDate };
  const g = extractReport(text, rooms);
  const found = Object.keys(g.values).filter((k) => k !== "rooms_available").length;
  const exact = !!g.extra?.format;
  if (!found || !(exact || (typeHint === "final_audit" && g.confidence >= 0.8))) {
    await db.update("reports", `id=eq.${reportId}`, { status: "processed" }, "id").catch(() => {});
    return { status: "stored", note: "Stored.", date: businessDate };
  }
  let date = businessDate;
  if (exact && g.business_date && g.business_date !== businessDate) {
    date = g.business_date; // the report itself is the authority on its business date
    await db.update("reports", `id=eq.${reportId}`, { business_date: date, report_type: "final_audit" }, "id");
  } else if (exact) await db.update("reports", `id=eq.${reportId}`, { report_type: "final_audit" }, "id");
  await db.update("reports", `id=eq.${reportId}`, { extracted: { values: g.values, deposits: g.deposits, business_date_in_file: g.business_date, extra: g.extra || null }, extracted_notes: g.notes }, "id");
  const status = await db.rpc<string>("ingest_report_v2", { p_report: reportId, p_values: g.values, p_confidence: g.confidence, p_deposits: Object.keys(g.deposits).length ? g.deposits : null, p_extra: g.extra || null });
  return { status, date, note: `${exact ? g.extra!.format + ": " : ""}${found} figures read in ${Math.round(performance.now() - t0)} ms for ${fmtDate(date)}.${g.notes.length ? " " + g.notes.join(" ") : ""}` };
}
