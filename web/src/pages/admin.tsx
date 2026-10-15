import React, { useRef, useState } from "react";
import { db, storage, currentSession } from "../lib/sb";
import { Ctx, REPORT_LABEL, guessReportType, yesterday, fmtDate, Hotel } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync } from "../ui";

const statusKind = (s: string) =>
  s === "processed" ? "good" : s === "needs_review" ? "warn" : s === "failed" ? "bad" : s === "superseded" ? "mute" : "info";

// ======================= Report Inbox =======================
export function Reports({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const canUpload = ctx.can("reports", "edit");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const [date, setDate] = useState(yesterday());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useAsync(async () => {
    const [rows, missing] = await Promise.all([
      db.get<any>(`reports?select=id,hotel_id,report_type,business_date,file_name,file_format,source,status,confidence,received_at&tenant_id=eq.${ctx.tenant.id}&order=received_at.desc&limit=80`),
      db.rpc<any[]>("missing_reports", { p_date: yesterday() }),
    ]);
    return { rows, missing };
  }, [ctx.tenant.id]);

  async function upload(files: FileList | File[]) {
    if (!hotelId) return;
    setBusy(true);
    setMsg(null);
    let ok = 0;
    try {
      for (const f of Array.from(files)) {
        const ext = (f.name.split(".").pop() || "").toUpperCase();
        const path = `${ctx.tenant.id}/${hotelId}/${date}/${Date.now()}-${f.name.replace(/[^\w.\- ]+/g, "_")}`;
        await storage.upload("reports", path, f);
        await db.insert("reports", {
          tenant_id: ctx.tenant.id, hotel_id: hotelId, report_type: guessReportType(f.name), business_date: date,
          file_name: f.name, file_path: path, file_format: ext, source: "upload", status: "received",
          uploaded_by: currentSession()?.user.id,
        });
        ok++;
      }
      setMsg({ kind: "good", text: `${ok} file${ok === 1 ? "" : "s"} uploaded. They're stored and queued for reading.` });
      q.reload();
    } catch (e: any) {
      setMsg({ kind: "bad", text: `Upload stopped after ${ok} file${ok === 1 ? "" : "s"}: ${e.message}` });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "—";

  return (
    <>
      <PageHead eyebrow="Data" title="Report Inbox" desc="Upload night audit, STR, OTA and other reports in any format. Each file is stored with its hotel and business date and queued for automatic reading." />
      {canUpload && (
        <Card title="Upload reports">
          <div className="fgrid" style={{ marginBottom: 14 }}>
            <div className="field"><label htmlFor="upHotel">Hotel</label>
              <select id="upHotel" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>
                {operating.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.city}</option>)}
              </select></div>
            <div className="field"><label htmlFor="upDate">Business date</label>
              <input id="upDate" type="date" value={date} max={yesterday()} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div className={"drop" + (over ? " over" : "")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}>
            <b>{busy ? "Uploading…" : "Drop files here"}</b>
            <span className="small muted">PDF, Excel, CSV, TXT, XML, images · up to 50 MB each</span>
            <label className="btn" htmlFor="upFile">Choose files</label>
            <input id="upFile" ref={fileRef} type="file" multiple hidden disabled={busy}
              onChange={(e) => e.target.files && e.target.files.length && upload(e.target.files)} />
          </div>
          {msg && <div className={"banner " + (msg.kind === "good" ? "info" : "bad")} style={{ marginTop: 12, marginBottom: 0 }}><span>{msg.text}</span></div>}
        </Card>
      )}
      <div className="sp" />
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <div className="grid g-2-1">
          <Card title="Recent reports" flush>
            {q.data.rows.length ? (
              <div className="tw"><table>
                <thead><tr><th>File</th><th>Hotel</th><th>Report</th><th>Date</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>{q.data.rows.map((r: any) => (
                  <tr key={r.id}>
                    <td><span className="small">{r.file_name}</span> <span className="chip">{r.file_format}</span></td>
                    <td className="nowrap">{hName(r.hotel_id)}</td>
                    <td>{REPORT_LABEL[r.report_type] || r.report_type}</td>
                    <td className="nowrap">{r.business_date ? fmtDate(r.business_date) : "—"}</td>
                    <td>{r.source}</td>
                    <td><Pill kind={statusKind(r.status) as any}>{r.status.replace("_", " ")}</Pill></td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty title="No reports yet." />}
          </Card>
          <Card title={`Missing for ${fmtDate(yesterday())}`} flush>
            {q.data.missing.length ? (
              <div className="list">{q.data.missing.map((m: any, i: number) => (
                <div className="li" key={i}><span className="stripe" style={{ background: "var(--bad)" }} />
                  <div><div className="t">{REPORT_LABEL[m.report_type]}</div><div className="s">{hName(m.hotel_id)}</div></div></div>
              ))}</div>
            ) : <Empty title="All required reports are in." />}
          </Card>
        </div>
      )}
    </>
  );
}

// ======================= Hotels =======================
export function Hotels({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("settings", "admin");
  const [editing, setEditing] = useState<Hotel | null>(null);
  const [err, setErr] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setErr("");
    try {
      const { id, name, rooms, str_id, property_code, address, city, state, zip, brand_family } = editing;
      await db.update("hotels", `id=eq.${id}`, { name, rooms: Number(rooms), str_id: str_id || null, property_code: property_code || null, address, city, state, zip, brand_family });
      setEditing(null);
      ctx.reload();
    } catch (e: any) { setErr(e.message); }
  }
  const groups: [string, Hotel[]][] = [
    ["Operating", ctx.hotels.filter((h) => h.status === "operating")],
    ["In development", ctx.hotels.filter((h) => h.status === "development")],
  ];
  return (
    <>
      <PageHead eyebrow="Setup" title="Hotels" desc="The hotels in this company. Room counts drive every per-room KPI, so check them first." />
      {groups.map(([g, list]) => list.length > 0 && (
        <React.Fragment key={g}>
          <Card title={g} flush>
            <div className="tw"><table>
              <thead><tr><th>Hotel</th><th>Brand</th><th>Address</th><th className="n">Rooms</th><th>STR ID</th><th>Code</th><th></th></tr></thead>
              <tbody>{list.map((h) => (
                <tr key={h.id}>
                  <td className="nowrap"><b>{h.name}</b><div className="tag">{h.city}, {h.state}</div></td>
                  <td>{h.brand_family}</td>
                  <td className="small">{h.address || "—"}{h.zip ? `, ${h.zip}` : ""}</td>
                  <td className="n">{h.rooms}</td>
                  <td>{h.str_id || "—"}</td>
                  <td>{h.property_code || "—"}</td>
                  <td>{canEdit && <button className="btn sm" onClick={() => setEditing({ ...h })}>Edit</button>}</td>
                </tr>
              ))}</tbody></table></div>
          </Card>
          <div className="sp" />
        </React.Fragment>
      ))}
      {editing && (
        <div className="modal-scrim" onClick={() => setEditing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save} aria-label="Edit hotel">
            <h3>Edit {editing.name}</h3>
            <div className="fgrid">
              {([["name", "Name"], ["brand_family", "Brand"], ["rooms", "Rooms"], ["str_id", "STR ID"], ["property_code", "Property code"], ["address", "Street address"], ["city", "City"], ["state", "State"], ["zip", "ZIP"]] as [keyof Hotel, string][]).map(([k, l]) => (
                <div className="field" key={k}><label htmlFor={"h-" + k}>{l}</label>
                  <input id={"h-" + k} type={k === "rooms" ? "number" : "text"} min={k === "rooms" ? 1 : undefined} required={k === "name" || k === "rooms"}
                    value={(editing[k] as any) ?? ""} onChange={(e) => setEditing({ ...editing, [k]: e.target.value } as Hotel)} /></div>
              ))}
            </div>
            {err && <div className="banner bad"><span>{err}</span></div>}
            <div className="acts" style={{ marginTop: 16 }}>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn pri">Save hotel</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

// ======================= Users & invites =======================
export function Users({ ctx }: { ctx: Ctx }) {
  const canAdmin = ctx.can("users", "admin");
  const q = useAsync(async () => {
    const [members, invites, roles] = await Promise.all([
      db.get<any>(`memberships?select=id,user_id,all_hotels,created_at,roles(name,key),membership_hotels(hotel_id)&tenant_id=eq.${ctx.tenant.id}`),
      canAdmin ? db.get<any>(`invites?select=*&tenant_id=eq.${ctx.tenant.id}&order=created_at.desc`) : Promise.resolve([]),
      db.get<any>(`roles?select=key,name,approval_limit&tenant_id=eq.${ctx.tenant.id}&order=name.asc`),
    ]);
    const ids = members.map((m: any) => m.user_id);
    const profiles = ids.length ? await db.get<any>(`profiles?select=user_id,full_name,email&user_id=in.(${ids.join(",")})`) : [];
    return { members, invites, roles, profiles };
  }, [ctx.tenant.id]);
  const [form, setForm] = useState({ email: "", role_key: "general_manager", all: false, hotels: [] as string[] });
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await db.insert("invites", { tenant_id: ctx.tenant.id, email: form.email.trim().toLowerCase(), role_key: form.role_key, all_hotels: form.all, hotel_ids: form.all ? [] : form.hotels, invited_by: currentSession()?.user.id });
      setMsg({ kind: "info", text: `Invite saved. When ${form.email} creates an account on this portal with that email, their access is applied automatically.` });
      setForm({ ...form, email: "", hotels: [] });
      q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";
  return (
    <>
      <PageHead eyebrow="Admin" title="Users & Permissions" desc="Access = role (what someone can do) + hotels (where). Invite people by email; they get access when they create their account." />
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <div className="grid g-2-1">
          <Card title="People" flush>
            <div className="tw"><table>
              <thead><tr><th>Name</th><th>Role</th><th>Hotels</th></tr></thead>
              <tbody>{q.data.members.map((m: any) => {
                const p = q.data!.profiles.find((x: any) => x.user_id === m.user_id);
                return (
                  <tr key={m.id}>
                    <td><b>{p?.full_name || "—"}</b><div className="tag">{p?.email}</div></td>
                    <td>{m.roles?.name}</td>
                    <td className="small">{m.all_hotels ? "All hotels" : m.membership_hotels.map((x: any) => hName(x.hotel_id)).join(", ") || "None"}</td>
                  </tr>
                );
              })}</tbody></table></div>
          </Card>
          {canAdmin && (
            <div className="grid">
              <Card title="Invite someone">
                <form onSubmit={invite} className="stack">
                  <div className="field"><label htmlFor="invEmail">Email</label>
                    <input id="invEmail" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" /></div>
                  <div className="field"><label htmlFor="invRole">Role</label>
                    <select id="invRole" value={form.role_key} onChange={(e) => setForm({ ...form, role_key: e.target.value })}>
                      {q.data.roles.map((r: any) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </select></div>
                  <label className="check-row" htmlFor="invAll"><input id="invAll" type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} /> All hotels, including future ones</label>
                  {!form.all && (
                    <fieldset className="hotel-picks"><legend>Hotels</legend>
                      {ctx.hotels.map((h) => (
                        <label key={h.id} className="check-row" htmlFor={"inv-" + h.id}>
                          <input id={"inv-" + h.id} type="checkbox" checked={form.hotels.includes(h.id)}
                            onChange={(e) => setForm({ ...form, hotels: e.target.checked ? [...form.hotels, h.id] : form.hotels.filter((x) => x !== h.id) })} />
                          {h.name} · {h.city}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <button className="btn pri" disabled={!form.all && !form.hotels.length}>Save invite</button>
                  {msg && <div className={"banner " + msg.kind} style={{ margin: 0 }}><span>{msg.text}</span></div>}
                </form>
              </Card>
              <Card title="Pending invites" flush>
                {q.data.invites.filter((i: any) => !i.accepted_at).length ? (
                  <div className="list">{q.data.invites.filter((i: any) => !i.accepted_at).map((i: any) => (
                    <div className="li" key={i.id}><div style={{ minWidth: 0 }}><div className="t">{i.email}</div>
                      <div className="s">{q.data!.roles.find((r: any) => r.key === i.role_key)?.name} · {i.all_hotels ? "All hotels" : i.hotel_ids.map(hName).join(", ")}</div></div></div>
                  ))}</div>
                ) : <Empty title="No pending invites." />}
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ======================= Company information =======================
const STATE_FIELDS: Record<string, [string, string][]> = {
  TX: [["tx_comptroller_no", "Texas Comptroller taxpayer no."], ["tx_hotel_tax", "State hotel occupancy tax account"], ["local_hot", "City / county hotel tax account"], ["twc_account", "Texas Workforce Commission account"], ["tabc", "Liquor license (TABC) no."]],
  FL: [["fl_dor_cert", "FL Dept. of Revenue certificate (sales & transient rental tax)"], ["county_tdt", "County tourist development tax account"], ["fl_reemployment", "Reemployment tax account"]],
};
export function Company({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("company", "edit");
  const q = useAsync(() => db.get<any>(`entities?select=*&tenant_id=eq.${ctx.tenant.id}&order=legal_name.asc`), [ctx.tenant.id]);
  const [edit, setEdit] = useState<any | null>(null);
  const [err, setErr] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      const { id, legal_name, dba, entity_type, formation_state, ein_last4, physical_address, mailing_address, phone, email, state_fields } = edit;
      if (ein_last4 && !/^\d{4}$/.test(ein_last4)) throw new Error("Enter only the last 4 digits of the EIN.");
      await db.update("entities", `id=eq.${id}`, { legal_name, dba, entity_type, formation_state, ein_last4: ein_last4 || null, physical_address, mailing_address, phone, email, state_fields });
      setEdit(null);
      q.reload();
    } catch (e: any) { setErr(e.message); }
  }
  const hotelOf = (eid: string) => ctx.hotels.find((h) => h.entity_id === eid);
  return (
    <>
      <PageHead eyebrow="Compliance" title="Company Information" desc="Each hotel's ownership entity: legal name, DBA, contact details and state registrations. Only the last 4 digits of the EIN are stored here." />
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <Card flush title="Entities">
          <div className="tw"><table>
            <thead><tr><th>Legal name</th><th>DBA</th><th>Hotel</th><th>State</th><th>EIN</th><th></th></tr></thead>
            <tbody>{q.data.map((e: any) => (
              <tr key={e.id}>
                <td><b>{e.legal_name}</b>{e.legal_name.startsWith("[") && <div className="tag dn">Needs the real legal name</div>}</td>
                <td className="small">{e.dba}</td>
                <td className="small">{hotelOf(e.id)?.name || "—"}</td>
                <td>{e.formation_state}</td>
                <td className="num">{e.ein_last4 ? `••-•••${e.ein_last4}` : "—"}</td>
                <td>{canEdit && <button className="btn sm" onClick={() => setEdit({ ...e, state_fields: e.state_fields || {} })}>Edit</button>}</td>
              </tr>
            ))}</tbody></table></div>
        </Card>
      )}
      {edit && (
        <div className="modal-scrim" onClick={() => setEdit(null)}>
          <form className="modal wide" onClick={(e) => e.stopPropagation()} onSubmit={save} aria-label="Edit entity">
            <h3>Company information</h3>
            <div className="fgrid">
              {[["legal_name", "Legal name"], ["dba", "DBA"], ["entity_type", "Entity type"], ["formation_state", "State of formation (2 letters)"], ["ein_last4", "EIN · last 4 digits"], ["phone", "Phone"], ["email", "Email"], ["physical_address", "Physical address"], ["mailing_address", "Mailing address"]].map(([k, l]) => (
                <div className="field" key={k}><label htmlFor={"e-" + k}>{l}</label>
                  <input id={"e-" + k} required={k === "legal_name"} maxLength={k === "formation_state" ? 2 : k === "ein_last4" ? 4 : undefined}
                    value={edit[k] ?? ""} onChange={(ev) => setEdit({ ...edit, [k]: k === "formation_state" ? ev.target.value.toUpperCase() : ev.target.value })} /></div>
              ))}
            </div>
            {STATE_FIELDS[edit.formation_state] && (
              <>
                <h4 style={{ margin: "18px 0 8px" }}>{edit.formation_state} registrations</h4>
                <div className="fgrid">
                  {STATE_FIELDS[edit.formation_state].map(([k, l]) => (
                    <div className="field" key={k}><label htmlFor={"s-" + k}>{l}</label>
                      <input id={"s-" + k} value={edit.state_fields[k] ?? ""} onChange={(ev) => setEdit({ ...edit, state_fields: { ...edit.state_fields, [k]: ev.target.value } })} /></div>
                  ))}
                </div>
                <p className="small muted">Requirements vary by state and city. Confirm with your tax adviser.</p>
              </>
            )}
            {err && <div className="banner bad"><span>{err}</span></div>}
            <div className="acts" style={{ marginTop: 16 }}>
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn pri">Save</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

// ======================= White-label settings =======================
export function Settings({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("settings", "admin");
  const [t, setT] = useState({ ...ctx.tenant });
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await db.update("tenants", `id=eq.${t.id}`, { brand_name: t.brand_name, accent_color: t.accent_color, logo_url: t.logo_url || null, email_sender: t.email_sender, custom_domain: t.custom_domain || null });
      setMsg({ kind: "info", text: "Saved. Everyone in this company now sees the new branding." });
      ctx.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  return (
    <>
      <PageHead eyebrow="Admin" title="White-label Settings" desc="What this company's people see: name, logo, color, web address and email sender." />
      <form onSubmit={save}>
        <Card title="Brand">
          <div className="fgrid">
            <div className="field"><label htmlFor="bName">Display name</label><input id="bName" disabled={!canEdit} value={t.brand_name || ""} onChange={(e) => setT({ ...t, brand_name: e.target.value })} /></div>
            <div className="field"><label htmlFor="bColor">Accent color</label>
              <div className="color-row"><input id="bColor" type="color" disabled={!canEdit} value={t.accent_color || "#9A7432"} onChange={(e) => setT({ ...t, accent_color: e.target.value })} /><span className="num">{t.accent_color}</span></div></div>
            <div className="field"><label htmlFor="bLogo">Logo image URL (leave empty for the default)</label><input id="bLogo" disabled={!canEdit} value={t.logo_url || ""} onChange={(e) => setT({ ...t, logo_url: e.target.value })} placeholder="https://…" /></div>
            <div className="field"><label htmlFor="bEmail">Email sender</label><input id="bEmail" disabled={!canEdit} value={t.email_sender || ""} onChange={(e) => setT({ ...t, email_sender: e.target.value })} /></div>
            <div className="field"><label htmlFor="bDomain">Custom web address</label><input id="bDomain" disabled={!canEdit} value={t.custom_domain || ""} onChange={(e) => setT({ ...t, custom_domain: e.target.value })} /></div>
            <div className="field"><span>Plan</span><input value={`${t.plan} · up to ${t.hotel_limit} hotels`} readOnly /></div>
          </div>
          {canEdit && <div className="acts" style={{ marginTop: 16 }}><button className="btn pri">Save branding</button></div>}
          {msg && <div className={"banner " + msg.kind} style={{ marginTop: 12, marginBottom: 0 }}><span>{msg.text}</span></div>}
        </Card>
      </form>
    </>
  );
}
