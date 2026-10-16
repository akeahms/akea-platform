import React, { useState } from "react";
import { db, currentSession } from "../lib/sb";
import { Ctx, Hotel, Level } from "../lib/app";
import { PageHead, Card, Loading, ErrorBox, Empty, useAsync, Notice, Pill, downloadFile, toCsv } from "../ui";

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
      const { id, name, rooms, str_id, property_code, address, city, state, zip, brand_family, report_email } = editing as any;
      await db.update("hotels", `id=eq.${id}`, { name, rooms: Number(rooms), str_id: str_id || null, property_code: property_code || null, address, city, state, zip, brand_family, report_email: report_email ? String(report_email).trim().toLowerCase() : null });
      setEditing(null);
      ctx.reload();
    } catch (e: any) { setErr(e.message); }
  }
  const [exporting, setExporting] = useState("");
  const [exportMsg, setExportMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  async function exportHotel(h: Hotel) {
    setExporting(h.id); setExportMsg(null);
    try {
      const { files, rows } = await hotelExport(h);
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const [name, csv] of Object.entries(files)) zip.file(`${name}.csv`, csv);
      zip.file("README.txt", `${h.name} — complete data export from the Akea portal, ${new Date().toISOString().slice(0, 10)}.\r\nOne CSV file per kind of record, this hotel only. Files are empty where the hotel has no records or your role can't see them (for example pay rates).\r\n`);
      const blob = await zip.generateAsync({ type: "uint8array" });
      downloadFile(`${h.name.replace(/[^\w\- ]+/g, "")} data ${new Date().toISOString().slice(0, 10)}.zip`, blob as unknown as BlobPart, "application/zip");
      setExportMsg({ kind: "good", text: `Exported ${rows.toLocaleString()} records from ${h.name} in ${Object.keys(files).length} files.` });
    } catch (e: any) { setExportMsg({ kind: "bad", text: e.message }); } finally { setExporting(""); }
  }
  const groups: [string, Hotel[]][] = [
    ["Operating", ctx.hotels.filter((h) => h.status === "operating")],
    ["In development", ctx.hotels.filter((h) => h.status === "development")],
  ];
  return (
    <>
      <PageHead eyebrow="Setup" title="Hotels" desc="The hotels in this company. Each hotel keeps its own books, team and records; nothing is shared between hotels. Room counts drive every per-room KPI, so check them first." />
      {exportMsg && <Notice kind={exportMsg.kind} onClose={() => setExportMsg(null)}>{exportMsg.text}</Notice>}
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
                  <td><div className="row-actions">
                    {canEdit && <button className="btn sm" onClick={() => setEditing({ ...h })}>Edit</button>}
                    {canEdit && <button className="btn sm" disabled={!!exporting} onClick={() => exportHotel(h)}>{exporting === h.id ? "Exporting…" : "Export data"}</button>}
                  </div></td>
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
              {([["name", "Name"], ["brand_family", "Brand"], ["rooms", "Rooms"], ["str_id", "STR ID"], ["property_code", "Property code"], ["address", "Street address"], ["city", "City"], ["state", "State"], ["zip", "ZIP"], ["report_email" as any, "Nightly report email address"]] as [keyof Hotel, string][]).map(([k, l]) => (
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
      <RolePermissions ctx={ctx} />
    </>
  );
}

// ======================= Role permissions =======================
// What each role can do, module by module. Ask AI is off for every role except the Principal until you turn it on.
const MODULES: { key: string; label: string; desc: string; levels: Level[] }[] = [
  { key: "dashboards", label: "Dashboards", desc: "Portfolio and hotel performance", levels: ["none", "view", "admin"] },
  { key: "reports", label: "Reports", desc: "Report inbox, nightly snapshot email", levels: ["none", "view", "edit", "admin"] },
  { key: "str", label: "STR market data", desc: "Competitive set index", levels: ["none", "view"] },
  { key: "ask_ai", label: "Ask AI", desc: "Plain-English questions about your data. Each question is billed by Anthropic (a few cents).", levels: ["none", "view"] },
  { key: "finance", label: "Finance", desc: "Bills, banking, accounting, budgets. Approve = approve bills up to the role's limit", levels: ["none", "view", "edit", "approve", "admin"] },
  { key: "purchasing", label: "Purchasing", desc: "Purchase orders", levels: ["none", "view", "edit", "approve"] },
  { key: "workforce", label: "Workforce", desc: "Schedule, time clock, timesheets. Approve = see pay rates and approve hours", levels: ["none", "view", "edit", "approve", "admin"] },
  { key: "operations", label: "Operations", desc: "Day-to-day hotel tasks", levels: ["none", "view", "edit", "admin"] },
  { key: "compliance", label: "Compliance", desc: "Document vault, permits, insurance", levels: ["none", "view", "edit", "admin"] },
  { key: "company", label: "Company information", desc: "Entities and state registrations", levels: ["none", "view", "edit", "admin"] },
  { key: "investor", label: "Investors", desc: "Investor records, distributions, loan package", levels: ["none", "view", "edit", "admin"] },
  { key: "construction", label: "Construction", desc: "Budgets, draws, milestones", levels: ["none", "view", "edit", "admin"] },
  { key: "users", label: "Users & permissions", desc: "Invite people; admin can change these permissions", levels: ["none", "view", "edit", "admin"] },
  { key: "settings", label: "Settings", desc: "Hotels and white-label branding", levels: ["none", "view", "admin"] },
];
const LEVEL_LABEL: Record<Level, string> = { none: "No access", view: "View", edit: "Edit", approve: "Approve", admin: "Admin" };

function RolePermissions({ ctx }: { ctx: Ctx }) {
  const canAdmin = ctx.can("users", "admin");
  const q = useAsync(() => db.get<any>(`roles?select=id,key,name,role_permissions(module,level)&tenant_id=eq.${ctx.tenant.id}&order=name.asc`), [ctx.tenant.id]);
  const [roleId, setRoleId] = useState("");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [saving, setSaving] = useState("");
  if (!ctx.can("users", "view")) return null;
  const roles = q.data || [];
  const role = roles.find((r: any) => r.id === roleId) || roles.find((r: any) => r.key !== "principal") || roles[0];
  const levelOf = (r: any, m: string): Level => (r?.role_permissions.find((p: any) => p.module === m)?.level as Level) || "none";
  const locked = (r: any) => r?.key === "principal";
  async function set(r: any, module: string, level: Level) {
    setSaving(r.id + module); setMsg(null);
    try {
      await db.upsert("role_permissions", { role_id: r.id, module, level }, "role_id,module", "role_id");
      setMsg({ kind: "good", text: `${r.name}: ${MODULES.find((m) => m.key === module)?.label} set to ${LEVEL_LABEL[level]}. People with this role see the change next time they sign in or refresh.` });
      q.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setSaving(""); }
  }
  return (
    <>
      <div className="sp" />
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <div className="grid g-2-1">
          <Card title="Role permissions" note={canAdmin ? "Changes apply to everyone with the role." : "Only admins can change these."}>
            {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
            <div className="field"><label htmlFor="rpRole">Role</label>
              <select id="rpRole" value={role?.id || ""} onChange={(e) => setRoleId(e.target.value)}>
                {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></div>
            {locked(role) && <p className="small muted">The Principal / CEO role always has full access, so it can't be locked out.</p>}
            <div className="tw"><table>
              <thead><tr><th>Area</th><th>Access</th></tr></thead>
              <tbody>{MODULES.map((m) => {
                const lv = levelOf(role, m.key);
                return (
                  <tr key={m.key}>
                    <td><b>{m.label}</b><div className="tag">{m.desc}</div></td>
                    <td style={{ width: 170 }}>
                      {m.key === "ask_ai" ? (
                        <label className="check-row" htmlFor={"rp-" + m.key} style={{ margin: 0 }}>
                          <input id={"rp-" + m.key} type="checkbox" checked={lv !== "none"} disabled={!canAdmin || locked(role) || !!saving}
                            onChange={(e) => set(role, m.key, e.target.checked ? "view" : "none")} /> {lv !== "none" ? "On" : "Off"}
                        </label>
                      ) : (
                        <select aria-label={`${m.label} access`} value={m.levels.includes(lv) ? lv : lv} disabled={!canAdmin || locked(role) || !!saving}
                          onChange={(e) => set(role, m.key, e.target.value as Level)}>
                          {[...new Set([...m.levels, lv])].map((l) => <option key={l} value={l}>{LEVEL_LABEL[l as Level]}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </Card>
          <Card title="Who can use Ask AI">
            <p className="small muted" style={{ marginTop: 0 }}>Off for everyone except the Principal until you switch it on here. Each question costs a few cents on your Anthropic account; each person can ask up to 60 a day.</p>
            <div className="list">{roles.map((r: any) => {
              const on = levelOf(r, "ask_ai") !== "none";
              return (
                <label key={r.id} className="li check-row" htmlFor={"ai-" + r.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input id={"ai-" + r.id} type="checkbox" checked={on} disabled={!canAdmin || locked(r) || !!saving} onChange={(e) => set(r, "ask_ai", e.target.checked ? "view" : "none")} />
                  <span className="grow">{r.name}</span>{on ? <Pill kind="good">On</Pill> : <Pill kind="mute">Off</Pill>}
                </label>
              );
            })}</div>
          </Card>
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

// ======================= Hotel data export =======================
// Everything one hotel owns, as CSV files (e.g. when a hotel is sold or changes management). Row security still applies.
const EXPORT_TABLES: [string, string][] = [
  ["gl_accounts", "*"], ["departments", "*"],
  ["employees", "id,hotel_id,first_name,last_name,email,phone,department_id,position,employment_type,status,hire_date"], ["employee_pay", "*"],
  ["shifts", "*"], ["time_punches", "*"], ["shift_requests", "*"],
  ["daily_metrics", "*"], ["daily_segments", "*"], ["report_stats", "*"], ["budget_daily", "*"], ["budget_gl", "*"], ["str_periods", "*"],
  ["reports", "*"], ["required_reports", "*"], ["expected_deposits", "*"],
  ["bank_accounts", "*"], ["statement_imports", "*"], ["bank_transactions", "*"],
  ["bills", "*"], ["purchase_orders", "*"], ["po_lines", "*"], ["journal_entries", "*"], ["journal_lines", "*"],
  ["permits", "*"], ["insurance_policies", "*"], ["documents", "*"],
  ["construction_budget", "*"], ["construction_draws", "*"], ["construction_milestones", "*"], ["change_orders", "*"],
  ["investor_holdings", "*"], ["distributions", "*"],
  ["qbo_settings", "*"], ["qbo_account_map", "*"], ["qbo_sync_log", "*"], ["snapshot_recipients", "*"], ["snapshot_sends", "*"], ["notifications", "*"],
];
async function hotelExport(h: Hotel) {
  const files: Record<string, string> = { hotel: toCsv([Object.keys(h), Object.values(h).map((v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)))]) };
  let rows = 1;
  for (const [table, cols] of EXPORT_TABLES) {
    const all: any[] = [];
    try {
      for (let offset = 0; offset < 200000; offset += 1000) {
        const page = await db.get<any>(`${table}?select=${cols}&hotel_id=eq.${h.id}&limit=1000&offset=${offset}`);
        all.push(...page);
        if (page.length < 1000) break;
      }
    } catch { /* not visible to this role: leave the file empty */ }
    const keys = all.length ? Object.keys(all[0]) : [];
    files[table] = toCsv([keys, ...all.map((r) => keys.map((k) => (r[k] == null ? "" : typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k])))]);
    rows += all.length;
  }
  return { files, rows };
}
