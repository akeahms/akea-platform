import React, { useRef, useState } from "react";
import { db, storage, currentSession } from "../lib/sb";
import { Ctx, fmtDate, todayIn, usd } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, HotelSelect, Notice, SampleBadge, Seg, downloadFile, toCsv } from "../ui";

export const FOLDERS: [string, string][] = [
  ["legal", "Legal & entity"], ["tax", "Tax"], ["insurance", "Insurance"], ["permits", "Permits & licences"], ["contracts", "Contracts"], ["hr", "HR"],
  ["floor_plans", "Floor plans"], ["loan", "Loan & lender"], ["investor", "Investor"], ["financials", "Financial statements"], ["construction", "Construction"], ["other", "Other"],
];
const folderName = (k: string) => FOLDERS.find((f) => f[0] === k)?.[1] || k;
const days = (d: string | null) => (d ? Math.round((Date.parse(d + "T12:00:00") - Date.parse(todayIn() + "T12:00:00")) / 864e5) : null);
export function expiryPill(d: string | null, lead = 60) {
  const n = days(d);
  if (n == null) return <Pill kind="mute">No expiry</Pill>;
  if (n < 0) return <Pill kind="bad">Expired {-n} days ago</Pill>;
  if (n <= 30) return <Pill kind="bad">{n} days left</Pill>;
  if (n <= lead) return <Pill kind="warn">{n} days left</Pill>;
  return <Pill kind="good">Current · {n} days</Pill>;
}
const sanitize = (n: string) => n.replace(/[^\w.\- ]+/g, "_");
export async function uploadDoc(ctx: Ctx, file: File, meta: { folder: string; hotel_id?: string | null; name?: string; expires_on?: string | null; tax_year?: number | null; visibility?: string; investor_id?: string | null; entity_id?: string | null; tags?: string[] }) {
  const path = `${ctx.tenant.id}/${meta.folder}/${meta.hotel_id || "company"}/${Date.now()}-${sanitize(file.name)}`;
  await storage.upload("vault", path, file);
  const [d] = await db.insert<any>("documents", { tenant_id: ctx.tenant.id, hotel_id: meta.hotel_id || null, entity_id: meta.entity_id || null, investor_id: meta.investor_id || null,
    folder: meta.folder, name: meta.name || file.name, file_path: path, file_size: file.size, mime: file.type || null, tags: meta.tags || [], tax_year: meta.tax_year || null,
    expires_on: meta.expires_on || null, visibility: meta.visibility || "internal", uploaded_by: currentSession()?.user.id }, "id,file_path");
  return d;
}
export async function openDoc(path: string) {
  const url = await storage.signedUrl("vault", path, 120);
  window.open(url, "_blank", "noopener");
}
const size = (b: number | null) => (b == null ? "" : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

// ======================= Document vault (incl. floor plans) =======================
export function Vault({ ctx, folder: initial }: { ctx: Ctx; folder?: string }) {
  const canEdit = ["compliance", "finance", "investor", "construction"].some((m) => ctx.can(m, "edit"));
  const [folder, setFolder] = useState(initial || "");
  const [hotelId, setHotelId] = useState("");
  const [search, setSearch] = useState("");
  const [up, setUp] = useState<{ files: File[]; folder: string; hotel_id: string; expires_on: string; tax_year: string; visibility: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useAsync(() => db.get<any>(`documents?select=*&tenant_id=eq.${ctx.tenant.id}${folder ? `&folder=eq.${folder}` : ""}${hotelId ? `&or=(hotel_id.eq.${hotelId},hotel_id.is.null)` : ""}&order=created_at.desc&limit=500`), [folder, hotelId]);
  const counts = useAsync(() => db.get<any>(`documents?select=folder&tenant_id=eq.${ctx.tenant.id}`), [q.data]);
  const list = (q.data || []).filter((d: any) => !search || `${d.name} ${d.tags?.join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const hName = (id: string | null) => (id ? ctx.hotels.find((h) => h.id === id)?.name : "Company-wide") || "";
  async function doUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!up) return;
    setBusy(true);
    let n = 0;
    try {
      for (const f of up.files) {
        await uploadDoc(ctx, f, { folder: up.folder, hotel_id: up.hotel_id || null, expires_on: up.expires_on || null, tax_year: up.tax_year ? Number(up.tax_year) : null, visibility: up.visibility });
        n++;
      }
      setMsg({ kind: "good", text: `${n} file${n === 1 ? "" : "s"} saved to ${folderName(up.folder)}.` });
      setUp(null); q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: `Stopped after ${n}: ${err.message}` }); } finally { setBusy(false); }
  }
  async function show(d: any) {
    try {
      const url = await storage.signedUrl("vault", d.file_path, 300);
      if (/^image\//.test(d.mime || "") || /\.(png|jpe?g|gif|webp|svg)$/i.test(d.name)) setPreview({ name: d.name, url });
      else window.open(url, "_blank", "noopener");
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  const startUpload = (files: File[]) => setUp({ files, folder: folder || "other", hotel_id: hotelId, expires_on: "", tax_year: "", visibility: "internal" });
  const isPlans = folder === "floor_plans";
  return (
    <>
      <PageHead eyebrow="Compliance" title={isPlans ? "Floor Plans" : "Document Vault"} desc={isPlans ? "Hotel floor plans, site plans and fire-escape maps — view them on any device." : "Every contract, licence, policy and statement in one private, searchable place. Files are only visible to people with access to that hotel and folder."}
        actions={canEdit && <><label className="btn pri" htmlFor="vaultFile">Upload files</label>
          <input id="vaultFile" ref={fileRef} type="file" multiple hidden onChange={(e) => { e.target.files?.length && startUpload(Array.from(e.target.files)); if (fileRef.current) fileRef.current.value = ""; }} /></>} />
      {!initial && (
        <div className="dept-chips">
          <button type="button" className={!folder ? "on" : ""} onClick={() => setFolder("")}>All folders · {(counts.data || []).length}</button>
          {FOLDERS.map(([k, l]) => <button type="button" key={k} className={folder === k ? "on" : ""} onClick={() => setFolder(k)} style={folder === k ? { background: "var(--fg)", color: "#fff", borderColor: "var(--fg)" } : undefined}>{l} · {(counts.data || []).filter((d: any) => d.folder === k).length}</button>)}
        </div>
      )}
      <div className="toolbar">
        <HotelSelect hotels={ctx.hotels} value={hotelId} onChange={setHotelId} all />
        <input type="search" aria-label="Search documents" placeholder="Search by name or tag" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 240 }} />
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {canEdit && (
        <div className="drop" style={{ marginBottom: 16 }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.dataTransfer.files.length && startUpload(Array.from(e.dataTransfer.files)); }}>
          <b>Drop files here</b><span className="small muted">PDF, Word, Excel, images, CAD exports · up to 50 MB each</span>
        </div>
      )}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (isPlans ? (
        list.length ? <div className="plans">{list.map((d: any) => <PlanTile key={d.id} d={d} hotel={hName(d.hotel_id)} onOpen={() => show(d)} />)}</div>
          : <Empty title="No floor plans yet.">Upload a PDF or image for each floor; staff can open them on a phone or tablet.</Empty>
      ) : (
        <Card flush>
          {list.length ? <div className="tw"><table>
            <thead><tr><th>Name</th><th>Folder</th><th>Hotel</th><th>Tax year</th><th>Expires</th><th>Shared with</th><th>Added</th><th></th></tr></thead>
            <tbody>{list.map((d: any) => (
              <tr key={d.id}>
                <td><b className="small">{d.name}</b><div className="tag">{size(d.file_size)}</div></td>
                <td className="small">{folderName(d.folder)}</td>
                <td className="small">{hName(d.hotel_id)}</td>
                <td className="small">{d.tax_year || "—"}</td>
                <td>{d.expires_on ? expiryPill(d.expires_on, 30) : <span className="muted">—</span>}</td>
                <td>{d.visibility === "investor" ? <Pill kind="info">Investors</Pill> : <Pill kind="mute">Internal</Pill>}</td>
                <td className="small nowrap">{fmtDate(d.created_at.slice(0, 10))}</td>
                <td><button className="btn sm" onClick={() => show(d)}>Open</button></td>
              </tr>
            ))}</tbody></table></div> : <Empty title="No documents here yet." />}
        </Card>
      ))}
      {up && (
        <Modal title={`Upload ${up.files.length} file${up.files.length === 1 ? "" : "s"}`} onClose={() => setUp(null)} onSubmit={doUpload}
          footer={<><button type="button" className="btn" onClick={() => setUp(null)}>Cancel</button><button className="btn pri" disabled={busy}>{busy ? "Uploading…" : "Upload"}</button></>}>
          <p className="small" style={{ marginTop: 0 }}>{up.files.map((f) => f.name).join(", ")}</p>
          <div className="fgrid">
            <Field label="Folder" id="uF"><select id="uF" value={up.folder} onChange={(e) => setUp({ ...up, folder: e.target.value })}>{FOLDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Hotel" id="uH"><select id="uH" value={up.hotel_id} onChange={(e) => setUp({ ...up, hotel_id: e.target.value })}><option value="">Company-wide</option>{ctx.hotels.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.city}</option>)}</select></Field>
            <Field label="Expires (optional)" id="uE" hint="You'll get an alert 30 days before"><input id="uE" type="date" value={up.expires_on} onChange={(e) => setUp({ ...up, expires_on: e.target.value })} /></Field>
            <Field label="Tax year (optional)" id="uT"><input id="uT" type="number" min="2000" max="2100" value={up.tax_year} onChange={(e) => setUp({ ...up, tax_year: e.target.value })} /></Field>
            <Field label="Shared with" id="uV"><select id="uV" value={up.visibility} onChange={(e) => setUp({ ...up, visibility: e.target.value })}><option value="internal">Internal team only</option><option value="investor">Also investors in this hotel</option></select></Field>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)} wide footer={<><a className="btn" href={preview.url} target="_blank" rel="noopener">Open full size</a><button className="btn" onClick={() => setPreview(null)}>Close</button></>}>
          <img src={preview.url} alt={preview.name} style={{ maxWidth: "100%", borderRadius: 10, border: "1px solid var(--line)" }} />
        </Modal>
      )}
    </>
  );
}
function PlanTile({ d, hotel, onOpen }: { d: any; hotel: string; onOpen: () => void }) {
  const isImg = /^image\//.test(d.mime || "") || /\.(png|jpe?g|gif|webp|svg)$/i.test(d.name);
  const thumb = useAsync(() => (isImg ? storage.signedUrl("vault", d.file_path, 600) : Promise.resolve("")), [d.id]);
  return (
    <button type="button" className="plan" onClick={onOpen}>
      <div className="thumb">{thumb.data ? <img src={thumb.data} alt="" /> : <span>{(d.name.split(".").pop() || "").toUpperCase()}</span>}</div>
      <b>{d.name}</b><span className="tag">{hotel}</span>
    </button>
  );
}

// ======================= Permits & licences =======================
export function Permits({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("compliance", "edit");
  const [hotelId, setHotelId] = useState("");
  const [show, setShow] = useState<"due" | "all">("all");
  const q = useAsync(() => db.get<any>(`permits?select=*,documents(file_path,name)&tenant_id=eq.${ctx.tenant.id}${hotelId ? `&hotel_id=eq.${hotelId}` : ""}&order=expires_on.asc.nullslast`), [hotelId]);
  const [edit, setEdit] = useState<any | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";
  const list = (q.data || []).filter((p: any) => show === "all" || (p.expires_on && days(p.expires_on)! <= (p.renewal_lead_days || 60)));
  const dueCount = (q.data || []).filter((p: any) => p.expires_on && days(p.expires_on)! <= (p.renewal_lead_days || 60)).length;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      let document_id = edit.document_id || null;
      if (file) document_id = (await uploadDoc(ctx, file, { folder: "permits", hotel_id: edit.hotel_id, name: `${edit.kind} — ${file.name}`, expires_on: edit.expires_on || null })).id;
      const row = { hotel_id: edit.hotel_id, kind: edit.kind, number: edit.number || null, issuer: edit.issuer || null, issued_on: edit.issued_on || null, expires_on: edit.expires_on || null,
        renewal_lead_days: Number(edit.renewal_lead_days || 60), notes: edit.notes || null, document_id };
      if (edit.id) await db.update("permits", `id=eq.${edit.id}`, row, "id"); else await db.insert("permits", { ...row, tenant_id: ctx.tenant.id }, "id");
      setEdit(null); setFile(null); setMsg({ kind: "good", text: "Permit saved. Renewal alerts follow the new expiry date." }); q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  return (
    <>
      <PageHead eyebrow="Compliance" title="Permits & Licences" desc="Every operating permit with its expiry date and document. Alerts go out 90, 60, 30 and 7 days before expiry."
        actions={<>
          <button className="btn" onClick={() => downloadFile("permits.csv", toCsv([["Hotel", "Permit", "Number", "Issuer", "Issued", "Expires"], ...(q.data || []).map((p: any) => [hName(p.hotel_id), p.kind, p.number, p.issuer, p.issued_on, p.expires_on])]))}>Export</button>
          {canEdit && <button className="btn pri" onClick={() => setEdit({ hotel_id: hotelId || ctx.hotels[0]?.id, kind: "", renewal_lead_days: 60 })}>Add permit</button>}</>} />
      <div className="toolbar"><HotelSelect hotels={ctx.hotels} value={hotelId} onChange={setHotelId} all />
        <Seg label="Show" value={show} onChange={setShow} options={[["all", "All"], ["due", `Renew soon · ${dueCount}`]]} /></div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush>
          {list.length ? <div className="tw"><table>
            <thead><tr><th>Permit</th>{!hotelId && <th>Hotel</th>}<th>Number</th><th>Issued by</th><th>Expires</th><th>Status</th><th>Document</th><th></th></tr></thead>
            <tbody>{list.map((p: any) => (
              <tr key={p.id}>
                <td><b>{p.kind}</b> <SampleBadge show={p.data_source === "sample"} /></td>
                {!hotelId && <td className="small">{hName(p.hotel_id)}</td>}
                <td className="small">{p.number || "—"}</td>
                <td className="small">{p.issuer || "—"}</td>
                <td className="small nowrap">{p.expires_on ? fmtDate(p.expires_on) : "—"}</td>
                <td>{expiryPill(p.expires_on, p.renewal_lead_days)}</td>
                <td>{p.documents ? <button className="btn sm" onClick={() => openDoc(p.documents.file_path)}>View</button> : <span className="tag">Not uploaded</span>}</td>
                <td>{canEdit && <button className="btn sm" onClick={() => setEdit({ ...p })}>{days(p.expires_on) != null && days(p.expires_on)! <= p.renewal_lead_days ? "Renew" : "Edit"}</button>}</td>
              </tr>
            ))}</tbody></table></div> : <Empty title={show === "due" ? "Nothing to renew in the next 60 days." : "No permits recorded yet."} />}
        </Card>
      )}
      {edit && (
        <Modal title={edit.id ? `${edit.kind}` : "Add permit"} onClose={() => setEdit(null)} onSubmit={save} wide
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri">Save</button></>}>
          <div className="fgrid">
            <Field label="Hotel" id="pmH"><HotelSelect hotels={ctx.hotels} value={edit.hotel_id} onChange={(v) => setEdit({ ...edit, hotel_id: v })} id="pmH" /></Field>
            <Field label="Permit or licence" id="pmK"><input id="pmK" required list="permitKinds" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} />
              <datalist id="permitKinds">{["Certificate of Occupancy", "Food Establishment Permit", "Fire Inspection Certificate", "Elevator Certificate", "Boiler Certificate", "Pool & Spa Permit", "State Hotel Occupancy Tax Permit", "Sales & Use Tax Permit", "Mixed Beverage Permit", "Sign Permit", "Business Licence", "Backflow Test"].map((k) => <option key={k} value={k} />)}</datalist></Field>
            <Field label="Number" id="pmN"><input id="pmN" value={edit.number || ""} onChange={(e) => setEdit({ ...edit, number: e.target.value })} /></Field>
            <Field label="Issued by" id="pmI"><input id="pmI" value={edit.issuer || ""} onChange={(e) => setEdit({ ...edit, issuer: e.target.value })} /></Field>
            <Field label="Issued on" id="pmIo"><input id="pmIo" type="date" value={edit.issued_on || ""} onChange={(e) => setEdit({ ...edit, issued_on: e.target.value })} /></Field>
            <Field label="Expires on" id="pmE"><input id="pmE" type="date" value={edit.expires_on || ""} onChange={(e) => setEdit({ ...edit, expires_on: e.target.value })} /></Field>
            <Field label="Start renewal (days before)" id="pmL"><input id="pmL" type="number" min="7" max="365" value={edit.renewal_lead_days} onChange={(e) => setEdit({ ...edit, renewal_lead_days: e.target.value })} /></Field>
            <Field label={edit.document_id ? "Replace document" : "Permit document"} id="pmF"><input id="pmF" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
            <Field label="Notes" id="pmNo" span><input id="pmNo" value={edit.notes || ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// ======================= Insurance =======================
export function Insurance({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("compliance", "edit");
  const q = useAsync(() => db.get<any>(`insurance_policies?select=*,documents(file_path)&tenant_id=eq.${ctx.tenant.id}&order=expires_on.asc`), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const hName = (id: string | null) => (id ? ctx.hotels.find((h) => h.id === id)?.name : "All hotels (company policy)") || "";
  const total = (q.data || []).reduce((a: number, p: any) => a + Number(p.premium || 0), 0);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      let document_id = edit.document_id || null;
      if (file) document_id = (await uploadDoc(ctx, file, { folder: "insurance", hotel_id: edit.hotel_id || null, name: `${edit.kind} policy — ${file.name}`, expires_on: edit.expires_on || null })).id;
      const { id, documents, data_source, created_at, tenant_id, ...rest } = edit;
      const row = { ...rest, hotel_id: rest.hotel_id || null, premium: rest.premium ? Number(rest.premium) : null, renewal_lead_days: Number(rest.renewal_lead_days || 90), document_id };
      if (id) await db.update("insurance_policies", `id=eq.${id}`, row, "id"); else await db.insert("insurance_policies", { ...row, tenant_id: ctx.tenant.id }, "id");
      setEdit(null); setFile(null); setMsg({ kind: "good", text: "Policy saved." }); q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  return (
    <>
      <PageHead eyebrow="Compliance" title="Insurance" desc={`Every policy, its limits and renewal date. Total annual premium ${usd(total)}. Renewal alerts start 90 days out.`}
        actions={canEdit && <button className="btn pri" onClick={() => setEdit({ hotel_id: "", kind: "", carrier: "", broker: "", policy_no: "", renewal_lead_days: 90 })}>Add policy</button>} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush>
          {q.data.length ? <div className="tw"><table>
            <thead><tr><th>Coverage</th><th>Covers</th><th>Carrier · broker</th><th>Policy</th><th>Limits</th><th>Deductible</th><th className="n">Premium</th><th>Renewal</th><th></th></tr></thead>
            <tbody>{q.data.map((p: any) => (
              <tr key={p.id}>
                <td><b>{p.kind}</b> <SampleBadge show={p.data_source === "sample"} /></td>
                <td className="small">{hName(p.hotel_id)}</td>
                <td className="small">{p.carrier}<div className="tag">{p.broker}</div></td>
                <td className="small">{p.policy_no}</td>
                <td className="small">{p.limits}</td>
                <td className="small">{p.deductible}</td>
                <td className="n">{p.premium ? usd(Number(p.premium)) : "—"}</td>
                <td className="nowrap">{expiryPill(p.expires_on, p.renewal_lead_days)}<div className="tag">{p.expires_on ? fmtDate(p.expires_on) : ""}</div></td>
                <td><div className="row-actions">{p.documents && <button className="btn sm" onClick={() => openDoc(p.documents.file_path)}>View</button>}{canEdit && <button className="btn sm" onClick={() => setEdit({ ...p })}>Edit</button>}</div></td>
              </tr>
            ))}</tbody></table></div> : <Empty title="No policies recorded yet." />}
        </Card>
      )}
      {edit && (
        <Modal title={edit.id ? `${edit.kind} policy` : "Add policy"} onClose={() => setEdit(null)} onSubmit={save} wide
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri">Save</button></>}>
          <div className="fgrid">
            <Field label="Coverage" id="iK"><input id="iK" required list="covKinds" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} />
              <datalist id="covKinds">{["Property", "General Liability", "Umbrella", "Workers Compensation", "Liquor Liability", "Employment Practices (EPLI)", "Cyber Liability", "Flood", "Builder's Risk", "Auto", "Crime / Fidelity", "Directors & Officers"].map((k) => <option key={k} value={k} />)}</datalist></Field>
            <Field label="Covers" id="iH"><select id="iH" value={edit.hotel_id || ""} onChange={(e) => setEdit({ ...edit, hotel_id: e.target.value })}><option value="">All hotels (company policy)</option>{ctx.hotels.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.city}</option>)}</select></Field>
            {([["carrier", "Carrier"], ["broker", "Broker"], ["policy_no", "Policy number"], ["limits", "Limits"], ["deductible", "Deductible"]] as [string, string][]).map(([k, l]) => (
              <Field key={k} label={l} id={"i" + k}><input id={"i" + k} value={edit[k] || ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>))}
            <Field label="Annual premium ($)" id="iP"><input id="iP" type="number" min="0" step="0.01" value={edit.premium || ""} onChange={(e) => setEdit({ ...edit, premium: e.target.value })} /></Field>
            <Field label="Effective" id="iEf"><input id="iEf" type="date" value={edit.effective_on || ""} onChange={(e) => setEdit({ ...edit, effective_on: e.target.value })} /></Field>
            <Field label="Expires" id="iEx"><input id="iEx" type="date" value={edit.expires_on || ""} onChange={(e) => setEdit({ ...edit, expires_on: e.target.value })} /></Field>
            <Field label={edit.document_id ? "Replace policy / certificate" : "Policy or certificate (PDF)"} id="iF"><input id="iF" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// ======================= Alerts (bell) =======================
export function useAlerts(ctx: Ctx) {
  return useAsync(async () => {
    const [n, r] = await Promise.all([
      db.get<any>(`notifications?select=*&tenant_id=eq.${ctx.tenant.id}&order=due_on.asc.nullslast,created_at.desc&limit=60`),
      db.get<any>(`notification_reads?select=notification_id`),
    ]);
    const read = new Set(r.map((x: any) => x.notification_id));
    return n.map((x: any) => ({ ...x, read: read.has(x.id) }));
  }, [ctx.tenant.id]);
}
export function AlertsPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const q = useAlerts(ctx);
  const unread = (q.data || []).filter((n: any) => !n.read);
  async function markAll() {
    if (unread.length) await db.insert("notification_reads", unread.map((n: any) => ({ notification_id: n.id })), "notification_id").catch(() => {});
    q.reload();
  }
  return (
    <div className="alerts" role="dialog" aria-label="Alerts">
      <div className="hd"><b>Alerts</b><span className="spacer" />{unread.length > 0 && <button className="link" onClick={markAll}>Mark all read</button>}<button className="btn sm" onClick={onClose}>Close</button></div>
      {q.loading && !q.data && <Loading />}
      {q.data && (q.data.length ? (
        <div className="list">{q.data.map((n: any) => (
          <a key={n.id} className={"li" + (n.read ? "" : " unread")} href={n.link || "#"} onClick={() => { if (!n.read) db.insert("notification_reads", { notification_id: n.id }, "notification_id").catch(() => {}); onClose(); }}>
            <span className="stripe" style={{ background: n.due_on && n.due_on < todayIn() ? "var(--bad)" : n.threshold != null && n.threshold <= 30 ? "var(--warn)" : "var(--info)" }} />
            <div style={{ minWidth: 0 }}><div className="t small">{n.title}</div><div className="s">{n.body}</div></div>
          </a>
        ))}</div>
      ) : <Empty title="You're all caught up." />)}
    </div>
  );
}
