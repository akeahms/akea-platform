import React, { useMemo, useState } from "react";
import { db, storage, currentSession } from "../lib/sb";
import { Ctx, usd, usdShort, pct, fmtDate, todayIn, addDays, yesterday, summary, kpi, periodRange, Period } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, HotelSelect, Notice, SampleBadge, Seg, Kpi, downloadFile, toCsv, Tabs, LineChart } from "../ui";
import { uploadDoc, openDoc, FOLDERS } from "./compliance";
import { buildPdf, money, Block } from "../lib/pdfdoc";

// ======================= Investors (management view) =======================
export function Investors({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("investor", "edit");
  const year = Number(todayIn().slice(0, 4));
  const q = useAsync(async () => {
    const [sum, inv, dist] = await Promise.all([
      db.rpc<any[]>("investor_summary", { p_year: year }),
      db.get<any>(`investors?select=*&tenant_id=eq.${ctx.tenant.id}&order=name.asc`),
      db.get<any>(`distributions?select=*&tenant_id=eq.${ctx.tenant.id}&order=paid_on.desc&limit=200`),
    ]);
    return { sum, inv, dist };
  }, []);
  const [tab, setTab] = useState<"owners" | "dist" | "docs">("owners");
  const [form, setForm] = useState<any | null>(null);
  const [distForm, setDistForm] = useState<any | null>(null);
  const [docForm, setDocForm] = useState<any | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const hName = (id: string) => ctx.hotels.find((h) => h.id === id)?.name || "";
  const iName = (id: string) => q.data?.inv.find((i: any) => i.id === id)?.name || "";
  const byInv = useMemo(() => {
    const m = new Map<string, any[]>();
    (q.data?.sum || []).forEach((r) => m.set(r.investor_id, [...(m.get(r.investor_id) || []), r]));
    return [...m.entries()];
  }, [q.data]);
  async function saveInvestor(e: React.FormEvent) {
    e.preventDefault();
    try {
      let user_id = form.user_id || null;
      if (form.login_email) {
        const p = await db.get<any>(`profiles?select=user_id&email=eq.${encodeURIComponent(form.login_email.trim().toLowerCase())}`);
        if (!p.length) throw new Error(`No portal account uses ${form.login_email} yet. Invite them as "Investor / Owner" on Users & Permissions first.`);
        user_id = p[0].user_id;
      }
      const row = { name: form.name, email: form.email || null, phone: form.phone || null, notes: form.notes || null, user_id };
      let id = form.id;
      if (id) await db.update("investors", `id=eq.${id}`, row, "id"); else id = (await db.insert<any>("investors", { ...row, tenant_id: ctx.tenant.id }, "id"))[0].id;
      for (const h of form.holdings || []) if (h.hotel_id && Number(h.pct) > 0)
        await db.upsert("investor_holdings", { tenant_id: ctx.tenant.id, investor_id: id, hotel_id: h.hotel_id, ownership_pct: Number(h.pct), capital_contributed: Number(h.capital || 0) }, "investor_id,hotel_id", "id");
      setForm(null); setMsg({ kind: "good", text: "Investor saved." }); q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  async function saveDist(e: React.FormEvent) {
    e.preventDefault();
    try {
      // split a hotel-level distribution by ownership %
      const holders = (q.data?.sum || []).filter((r) => r.hotel_id === distForm.hotel_id);
      if (!holders.length) throw new Error("Nobody owns a share of that hotel yet.");
      const total = Number(distForm.amount);
      await db.insert("distributions", holders.map((h) => ({ tenant_id: ctx.tenant.id, investor_id: h.investor_id, hotel_id: h.hotel_id, paid_on: distForm.paid_on, amount: Math.round(total * h.ownership_pct) / 100, memo: distForm.memo || null })), "id");
      setDistForm(null); setMsg({ kind: "good", text: `Distribution of ${usd(total, 2)} recorded and split across ${holders.length} owners.` }); q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  async function saveDoc(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (!docForm.file) throw new Error("Choose the file.");
      await uploadDoc(ctx, docForm.file, { folder: docForm.folder, hotel_id: docForm.hotel_id || null, investor_id: docForm.investor_id || null, tax_year: docForm.tax_year ? Number(docForm.tax_year) : null, visibility: "investor", name: docForm.name || docForm.file.name });
      setDocForm(null); setMsg({ kind: "good", text: docForm.investor_id ? `Shared privately with ${iName(docForm.investor_id)}.` : "Shared with every investor in that hotel." });
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  const ytdTotal = (q.data?.sum || []).reduce((a, r) => a + Number(r.distributions_ytd), 0);
  const capital = (q.data?.sum || []).reduce((a, r) => a + Number(r.capital), 0);
  return (
    <>
      <PageHead eyebrow="Investors" title="Investor Relations" desc="Who owns what, distributions, and the reports and tax documents each investor sees in their portal."
        actions={canEdit && <>
          <button className="btn" onClick={() => setDocForm({ folder: "tax", hotel_id: "", investor_id: "", tax_year: String(new Date().getFullYear() - 1) })}>Share a document</button>
          <button className="btn" onClick={() => setDistForm({ hotel_id: ctx.hotels.find((h) => h.status === "operating")?.id, amount: "", paid_on: todayIn(), memo: "" })}>Record distribution</button>
          <button className="btn pri" onClick={() => setForm({ name: "", holdings: [{ hotel_id: "", pct: "", capital: "" }] })}>Add investor</button></>} />
      <div className="stat-row">
        <Kpi label="Investors" value={q.data?.inv.length ?? "—"} />
        <Kpi label="Capital contributed" value={usdShort(capital)} />
        <Kpi label={`Distributions ${year}`} value={usdShort(ytdTotal)} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[["owners", "Ownership"], ["dist", "Distributions"], ["docs", "Shared documents"]]} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && tab === "owners" && (
        <div className="grid g2">{byInv.map(([id, rows]) => {
          const inv = q.data!.inv.find((i: any) => i.id === id);
          return (
            <Card key={id} title={<>{rows[0].investor} <SampleBadge show={inv?.data_source === "sample"} /></>} note={inv?.user_id ? <Pill kind="good">Portal access</Pill> : <Pill kind="mute">No portal login</Pill>}
              actions={canEdit && <button className="btn sm" onClick={() => setForm({ ...inv, holdings: rows.map((r) => ({ hotel_id: r.hotel_id, pct: r.ownership_pct, capital: r.capital })) })}>Edit</button>} flush>
              <div className="tw"><table>
                <thead><tr><th>Hotel</th><th className="n">Ownership</th><th className="n">Capital</th><th className="n">Dist. YTD</th><th className="n">Dist. total</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.hotel_id}><td className="small">{r.hotel}</td><td className="n">{Number(r.ownership_pct).toFixed(1)}%</td><td className="n">{usd(Number(r.capital))}</td><td className="n">{usd(Number(r.distributions_ytd))}</td><td className="n">{usd(Number(r.distributions_total))}</td></tr>)}</tbody>
              </table></div>
            </Card>
          );
        })}{!byInv.length && <Empty title="No investors yet." />}</div>
      )}
      {q.data && tab === "dist" && (
        <Card flush>
          {q.data.dist.length ? <div className="tw"><table>
            <thead><tr><th>Paid</th><th>Investor</th><th>Hotel</th><th>Memo</th><th className="n">Amount</th></tr></thead>
            <tbody>{q.data.dist.map((d: any) => <tr key={d.id}><td className="small nowrap">{fmtDate(d.paid_on)}</td><td>{iName(d.investor_id)}</td><td className="small">{hName(d.hotel_id)}</td><td className="small">{d.memo}</td><td className="n">{usd(Number(d.amount), 2)}</td></tr>)}</tbody>
          </table></div> : <Empty title="No distributions recorded." />}
        </Card>
      )}
      {tab === "docs" && <InvestorDocs ctx={ctx} investors={q.data?.inv || []} />}
      {form && (
        <Modal title={form.id ? `Edit ${form.name}` : "Add investor"} onClose={() => setForm(null)} onSubmit={saveInvestor} wide footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri">Save</button></>}>
          <div className="fgrid">
            <Field label="Investor name (person, trust or company)" id="ivN"><input id="ivN" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Email" id="ivE"><input id="ivE" type="email" value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Phone" id="ivP"><input id="ivP" value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Portal login email" id="ivL" hint="Links their investor portal; invite them first"><input id="ivL" type="email" value={form.login_email || ""} onChange={(e) => setForm({ ...form, login_email: e.target.value })} /></Field>
          </div>
          <h4 style={{ margin: "16px 0 8px" }}>Ownership</h4>
          {(form.holdings || []).map((h: any, i: number) => {
            const set = (k: string, v: string) => setForm({ ...form, holdings: form.holdings.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) });
            return (
              <div className="fgrid" key={i} style={{ marginBottom: 8 }}>
                <Field label="Hotel" id={"hh" + i}><select id={"hh" + i} value={h.hotel_id} onChange={(e) => set("hotel_id", e.target.value)}><option value="">Choose…</option>{ctx.hotels.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.city}</option>)}</select></Field>
                <Field label="Ownership %" id={"hp" + i}><input id={"hp" + i} type="number" min="0" max="100" step="0.01" value={h.pct} onChange={(e) => set("pct", e.target.value)} /></Field>
                <Field label="Capital contributed ($)" id={"hc" + i}><input id={"hc" + i} type="number" min="0" step="0.01" value={h.capital} onChange={(e) => set("capital", e.target.value)} /></Field>
              </div>
            );
          })}
          <button type="button" className="btn sm" onClick={() => setForm({ ...form, holdings: [...(form.holdings || []), { hotel_id: "", pct: "", capital: "" }] })}>Add another hotel</button>
        </Modal>
      )}
      {distForm && (
        <Modal title="Record distribution" onClose={() => setDistForm(null)} onSubmit={saveDist} footer={<><button type="button" className="btn" onClick={() => setDistForm(null)}>Cancel</button><button className="btn pri">Record</button></>}>
          <div className="fgrid">
            <Field label="Hotel" id="dH"><HotelSelect hotels={ctx.hotels} value={distForm.hotel_id} onChange={(v) => setDistForm({ ...distForm, hotel_id: v })} id="dH" /></Field>
            <Field label="Total distributed ($)" id="dA"><input id="dA" type="number" min="0" step="0.01" required value={distForm.amount} onChange={(e) => setDistForm({ ...distForm, amount: e.target.value })} /></Field>
            <Field label="Paid on" id="dP"><input id="dP" type="date" required value={distForm.paid_on} onChange={(e) => setDistForm({ ...distForm, paid_on: e.target.value })} /></Field>
            <Field label="Memo" id="dM"><input id="dM" value={distForm.memo} onChange={(e) => setDistForm({ ...distForm, memo: e.target.value })} placeholder="e.g. Q3 2026 distribution" /></Field>
          </div>
          <p className="small muted">The total is split across owners by their ownership %.</p>
        </Modal>
      )}
      {docForm && (
        <Modal title="Share a document with investors" onClose={() => setDocForm(null)} onSubmit={saveDoc} footer={<><button type="button" className="btn" onClick={() => setDocForm(null)}>Cancel</button><button className="btn pri">Share</button></>}>
          <div className="fgrid">
            <Field label="File" id="sdF"><input id="sdF" type="file" required onChange={(e) => setDocForm({ ...docForm, file: e.target.files?.[0] })} /></Field>
            <Field label="Title" id="sdN"><input id="sdN" value={docForm.name || ""} onChange={(e) => setDocForm({ ...docForm, name: e.target.value })} placeholder="e.g. 2025 Schedule K-1" /></Field>
            <Field label="Type" id="sdT"><select id="sdT" value={docForm.folder} onChange={(e) => setDocForm({ ...docForm, folder: e.target.value })}><option value="tax">Tax document / K-1</option><option value="investor">Investor report</option><option value="financials">Financial statements</option></select></Field>
            <Field label="Hotel" id="sdH"><select id="sdH" value={docForm.hotel_id} onChange={(e) => setDocForm({ ...docForm, hotel_id: e.target.value })}><option value="">All hotels</option>{ctx.hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
            <Field label="Only this investor (K-1s)" id="sdI"><select id="sdI" value={docForm.investor_id} onChange={(e) => setDocForm({ ...docForm, investor_id: e.target.value })}><option value="">Every investor in the hotel</option>{(q.data?.inv || []).map((i: any) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
            <Field label="Tax year" id="sdY"><input id="sdY" type="number" value={docForm.tax_year} onChange={(e) => setDocForm({ ...docForm, tax_year: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
function InvestorDocs({ ctx, investors }: { ctx: Ctx; investors: any[] }) {
  const q = useAsync(() => db.get<any>(`documents?select=*&tenant_id=eq.${ctx.tenant.id}&visibility=eq.investor&order=created_at.desc`), []);
  return (
    <Card flush>
      {q.loading && <Loading />}
      {q.data && (q.data.length ? <div className="tw"><table>
        <thead><tr><th>Document</th><th>Type</th><th>Hotel</th><th>Visible to</th><th>Tax year</th><th></th></tr></thead>
        <tbody>{q.data.map((d: any) => <tr key={d.id}><td><b className="small">{d.name}</b></td><td className="small">{FOLDERS.find((f) => f[0] === d.folder)?.[1]}</td>
          <td className="small">{ctx.hotels.find((h) => h.id === d.hotel_id)?.name || "All"}</td><td className="small">{d.investor_id ? investors.find((i) => i.id === d.investor_id)?.name : "All investors in hotel"}</td>
          <td className="small">{d.tax_year || "—"}</td><td><button className="btn sm" onClick={() => openDoc(d.file_path)}>Open</button></td></tr>)}</tbody>
      </table></div> : <Empty title="Nothing shared with investors yet." />)}
    </Card>
  );
}

// ======================= Investor portal (what an investor sees) =======================
export function InvestorPortal({ ctx }: { ctx: Ctx }) {
  const year = Number(todayIn().slice(0, 4));
  const [period, setPeriod] = useState<Period>("YTD");
  const q = useAsync(async () => {
    const holdings = await db.rpc<any[]>("investor_summary", { p_year: year });
    const myHotels = [...new Set(holdings.map((h) => h.hotel_id))];
    const [docs, dist] = await Promise.all([
      db.get<any>(`documents?select=*&visibility=eq.investor&order=created_at.desc`),
      db.get<any>(`distributions?select=*&order=paid_on.desc&limit=40`),
    ]);
    return { holdings, myHotels, docs, dist };
  }, []);
  const hotels = q.data?.myHotels.length ? q.data.myHotels : ctx.hotels.map((h) => h.id);
  const perf = useAsync(async () => {
    const r = periodRange(period);
    const ly: [string, string] = [addDays(r[0], -364), addDays(r[1], -364)];
    const [cur, prev] = await Promise.all([summary(r, hotels), summary(ly, hotels)]);
    const hist = await db.rpc<any[]>("monthly_history", { p_hotels: hotels, p_from: `${year - 1}-${todayIn().slice(5, 7)}-01`, p_to: yesterday() });
    return { cur, prev, hist };
  }, [hotels.join(), period]);
  const me = currentSession()?.user.email;
  const own = (q.data?.holdings || []);
  const operating = ctx.hotels.filter((h) => hotels.includes(h.id) && h.status === "operating");
  return (
    <>
      <PageHead eyebrow="Investor portal" title={own[0]?.investor ? `Welcome, ${own[0].investor}` : "Investor Portal"} desc={`Performance of the hotels you own, your distributions, and your reports and tax documents. Signed in as ${me}.`}
        actions={<><Seg label="Period" value={period} onChange={setPeriod} options={[["MTD", "Month to date"], ["YTD", "Year to date"]]} /><button className="btn" onClick={() => window.print()}>Print</button></>} />
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {perf.data && (() => {
        const c = kpi(perf.data.cur.all), p = kpi(perf.data.prev.all);
        const d = (a: number, b: number, f: (v: number) => string) => b ? <span className={"d " + (a >= b ? "up" : "dn")}>{a >= b ? "↑" : "↓"} {f(Math.abs(a - b))} vs last year</span> : undefined;
        return (
          <div className="kpis">
            <Kpi label="Occupancy" value={pct(c.occ)} delta={d(c.occ, p.occ, (v) => pct(v))} />
            <Kpi label="Average rate (ADR)" value={usd(c.adr, 2)} delta={d(c.adr, p.adr, (v) => usd(v, 2))} />
            <Kpi label="RevPAR" value={usd(c.revpar, 2)} delta={d(c.revpar, p.revpar, (v) => usd(v, 2))} />
            <Kpi label="Total revenue" value={usdShort(c.total)} delta={d(c.total, p.total, usdShort)} />
          </div>
        );
      })()}
      {q.data && (
        <div className="grid g-2-1">
          <div className="grid">
            {perf.data && (
              <Card title="Revenue and profit by month">
                <LineChart labels={perf.data.hist.map((m: any) => new Date(m.month + "T12:00:00").toLocaleString("en-US", { month: "short" }))}
                  series={[{ name: "Revenue", values: perf.data.hist.map((m: any) => Number(m.total_revenue)), color: "var(--accent)" },
                    { name: "Operating profit", values: perf.data.hist.map((m: any) => Number(m.total_revenue) - Number(m.expenses)), color: "#2E8B57" }]} fmt={usdShort} />
              </Card>
            )}
            <Card title="Your ownership" flush>
              {own.length ? <div className="tw"><table>
                <thead><tr><th>Hotel</th><th className="n">Ownership</th><th className="n">Capital</th><th className="n">Distributions {year}</th><th className="n">Since inception</th></tr></thead>
                <tbody>{own.map((r) => <tr key={r.investor_id + r.hotel_id}><td>{r.hotel}{own.some((x) => x.investor_id !== r.investor_id) && <div className="tag">{r.investor}</div>}</td><td className="n">{Number(r.ownership_pct).toFixed(1)}%</td><td className="n">{usd(Number(r.capital))}</td><td className="n">{usd(Number(r.distributions_ytd))}</td><td className="n">{usd(Number(r.distributions_total))}</td></tr>)}</tbody>
              </table></div> : <Empty title="Your ownership details will appear here once they're set up." />}
            </Card>
            {perf.data && operating.length > 0 && (
              <Card title="Hotel performance" flush>
                <div className="tw"><table>
                  <thead><tr><th>Hotel</th><th className="n">Occupancy</th><th className="n">ADR</th><th className="n">RevPAR</th><th className="n">Revenue</th></tr></thead>
                  <tbody>{operating.map((h) => { const t = perf.data!.cur.byHotel.get(h.id); if (!t) return null; const k = kpi(t); return <tr key={h.id}><td>{h.name}<div className="tag">{h.city}, {h.state}</div></td><td className="n">{pct(k.occ)}</td><td className="n">{usd(k.adr, 2)}</td><td className="n">{usd(k.revpar, 2)}</td><td className="n">{usd(k.total)}</td></tr>; })}</tbody>
                </table></div>
              </Card>
            )}
          </div>
          <div className="grid" style={{ alignContent: "start" }}>
            <Card title="Reports & tax documents" flush>
              {q.data.docs.length ? <div className="list">{q.data.docs.map((d: any) => (
                <div className="li" key={d.id} style={{ alignItems: "center" }}><div style={{ minWidth: 0 }}><div className="t small">{d.name}</div><div className="s">{FOLDERS.find((f) => f[0] === d.folder)?.[1]}{d.tax_year ? ` · ${d.tax_year}` : ""} · {fmtDate(d.created_at.slice(0, 10))}</div></div>
                  <div className="r"><button className="btn sm" onClick={() => openDoc(d.file_path)}>Open</button></div></div>
              ))}</div> : <Empty title="No documents shared yet." />}
            </Card>
            <Card title="Distributions" flush>
              {q.data.dist.length ? <div className="list">{q.data.dist.slice(0, 12).map((d: any) => (
                <div className="li" key={d.id}><div><div className="t small">{usd(Number(d.amount), 2)}</div><div className="s">{fmtDate(d.paid_on)} · {ctx.hotels.find((h) => h.id === d.hotel_id)?.name} · {d.memo}</div></div></div>
              ))}</div> : <Empty title="No distributions yet." />}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

// ======================= One-click loan package =======================
export function LoanPackage({ ctx }: { ctx: Ctx }) {
  const [hotelId, setHotelId] = useState(ctx.hotels.find((h) => h.status === "operating")?.id || ctx.hotels[0]?.id || "");
  const [months, setMonths] = useState<"24" | "36" | "12">("24");
  const [incl, setIncl] = useState({ docs: true, pfs: true, str: true, permits: true, insurance: true, budget: true });
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const hotel = ctx.hotels.find((h) => h.id === hotelId)!;
  const brand = ctx.tenant.brand_name || ctx.tenant.name;
  async function build() {
    setBusy(true); setErr(""); setLog([]);
    const step = (s: string) => setLog((l) => [...l, s]);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const to = yesterday();
      const from = `${addDays(to, -Number(months) * 30.5).slice(0, 7)}-01`;
      const folder = (n: string) => zip.folder(n)!;
      const index: [string, string][] = [];
      // company & hotel
      step("Company and property information");
      const ent = hotel.entity_id ? (await db.get<any>(`entities?select=*&id=eq.${hotel.entity_id}`))[0] : null;
      const sf = ent?.state_fields || {};
      const compPdf = await buildPdf({ title: `${hotel.name} — Borrower & Property Information`, subtitle: `Prepared ${fmtDate(todayIn())}`, brand, accent: ctx.tenant.accent_color || undefined, blocks: [
        { h: "Property" },
        { kv: [["Hotel", hotel.name], ["Brand", hotel.brand_family || ""], ["Address", [hotel.address, hotel.city, hotel.state, hotel.zip].filter(Boolean).join(", ")], ["Rooms", String(hotel.rooms)], ["Status", hotel.status === "operating" ? "Operating" : `In development · opening ${hotel.opening_date ? fmtDate(hotel.opening_date) : "TBD"}`], ["STR ID", hotel.str_id || ""]] },
        { h: "Ownership entity" },
        { kv: ent ? [["Legal name", ent.legal_name], ["DBA", ent.dba || ""], ["Entity type", ent.entity_type || ""], ["State of formation", ent.formation_state || ""], ["EIN", ent.ein_last4 ? `XX-XXX${ent.ein_last4} (full number provided separately)` : ""], ["Physical address", ent.physical_address || ""], ["Mailing address", ent.mailing_address || ""], ["Phone", ent.phone || ""], ["Email", ent.email || ""], ...Object.entries(sf).map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string])] : [["Entity", "Not set up yet — add it on Company Information"]] },
      ] });
      zip.file("01 Borrower & Property Information.pdf", compPdf); index.push(["01 Borrower & Property Information.pdf", "Property and ownership entity details"]);
      // operating history
      step(`Operating history (${months} months)`);
      const hist = await db.rpc<any[]>("monthly_history", { p_hotels: [hotelId], p_from: from, p_to: to });
      const rows = hist.filter((m) => Number(m.total_revenue) > 0);
      const t12 = rows.slice(-12);
      const sum = (rs: any[], k: string) => rs.reduce((a, r) => a + Number(r[k] || 0), 0);
      const histRows = rows.map((m) => {
        const occ = Number(m.rooms_available) ? Number(m.rooms_sold) / Number(m.rooms_available) : 0;
        const adr = Number(m.rooms_sold) ? Number(m.room_revenue) / Number(m.rooms_sold) : 0;
        return [new Date(m.month + "T12:00:00").toLocaleString("en-US", { month: "short", year: "numeric" }), (occ * 100).toFixed(1) + "%", money(adr, 2), money(Number(m.room_revenue) / (Number(m.rooms_available) || 1), 2), money(Number(m.total_revenue)), money(Number(m.expenses)), money(Number(m.total_revenue) - Number(m.expenses))];
      });
      const ttmRev = sum(t12, "total_revenue"), ttmExp = sum(t12, "expenses");
      const histPdf = await buildPdf({ title: `${hotel.name} — Operating History`, subtitle: `${fmtDate(from)} to ${fmtDate(to)} · trailing twelve months revenue ${money(ttmRev)}, operating profit ${money(ttmRev - ttmExp)}`, brand, accent: ctx.tenant.accent_color || undefined, blocks: [
        { h: "Trailing twelve months" },
        { kv: [["Rooms sold", Math.round(sum(t12, "rooms_sold")).toLocaleString()], ["Occupancy", pct(sum(t12, "rooms_sold") / (sum(t12, "rooms_available") || 1))], ["ADR", money(sum(t12, "room_revenue") / (sum(t12, "rooms_sold") || 1), 2)], ["RevPAR", money(sum(t12, "room_revenue") / (sum(t12, "rooms_available") || 1), 2)], ["Total revenue", money(ttmRev)], ["Operating expenses", money(ttmExp)], ["Net operating income (before debt service)", money(ttmRev - ttmExp)]] },
        { h: "By month" },
        { table: { head: ["Month", "Occupancy", "ADR", "RevPAR", "Revenue", "Expenses", "Operating profit"], rows: [...histRows, ["Total", "", "", "", money(sum(rows, "total_revenue")), money(sum(rows, "expenses")), money(sum(rows, "total_revenue") - sum(rows, "expenses"))]], widths: [1.2, 1, 1, 1, 1.3, 1.3, 1.4] } },
        { p: "Revenue from nightly audit reports; expenses from the general ledger. Unaudited management figures.", muted: true, size: 8 },
      ] });
      zip.file("02 Operating History.pdf", histPdf);
      zip.file("02 Operating History.csv", toCsv([["Month", "Rooms available", "Rooms sold", "Room revenue", "Total revenue", "Expenses", "Budget revenue"], ...hist.map((m) => [m.month, m.rooms_available, m.rooms_sold, m.room_revenue, m.total_revenue, m.expenses, m.budget_revenue])]));
      index.push(["02 Operating History.pdf / .csv", `Monthly occupancy, ADR, RevPAR, revenue, expenses (${months} months)`]);
      if (incl.str) {
        step("STR market performance");
        const str = await db.get<any>(`str_periods?select=*&hotel_id=eq.${hotelId}&period_type=eq.month&order=period_end.desc&limit=24`).catch(() => []);
        if (str.length) {
          zip.file("03 STR Market Performance.csv", toCsv([["Month ending", "Occupancy", "Comp set occupancy", "ADR", "Comp set ADR", "RevPAR", "Comp set RevPAR", "MPI", "ARI", "RGI"], ...str.reverse().map((s: any) => [s.period_end, s.occ, s.occ_comp, s.adr, s.adr_comp, s.revpar, s.revpar_comp, s.mpi, s.ari, s.rgi])]));
          index.push(["03 STR Market Performance.csv", "Monthly index vs competitive set (subject to STR licence terms)"]);
        }
      }
      if (incl.budget) {
        step("Current-year budget");
        const y = todayIn().slice(0, 4);
        const b = await db.rpc<any[]>("monthly_history", { p_hotels: [hotelId], p_from: `${y}-01-01`, p_to: `${y}-12-31` });
        zip.file(`04 ${y} Budget vs Actual.csv`, toCsv([["Month", "Budget revenue", "Actual revenue", "Actual expenses"], ...b.map((m) => [m.month, m.budget_revenue, m.total_revenue, m.expenses])]));
        index.push([`04 ${y} Budget vs Actual.csv`, "Budgeted and actual revenue by month"]);
      }
      if (incl.permits) {
        step("Permits & licences");
        const pm = await db.get<any>(`permits?select=*,documents(file_path,name)&hotel_id=eq.${hotelId}&order=kind.asc`);
        zip.file("05 Permits & Licences.csv", toCsv([["Permit", "Number", "Issuer", "Issued", "Expires"], ...pm.map((p: any) => [p.kind, p.number, p.issuer, p.issued_on, p.expires_on])]));
        for (const p of pm) if (p.documents) { try { folder("05 Permits & Licences").file(p.documents.name, await storage.download("vault", p.documents.file_path)); } catch { /* skip unreadable */ } }
        index.push(["05 Permits & Licences", `${pm.length} permits with expiry dates and copies on file`]);
      }
      if (incl.insurance) {
        step("Insurance schedule");
        const ins = await db.get<any>(`insurance_policies?select=*,documents(file_path,name)&or=(hotel_id.eq.${hotelId},hotel_id.is.null)&order=kind.asc`);
        zip.file("06 Insurance Schedule.csv", toCsv([["Coverage", "Carrier", "Policy", "Limits", "Deductible", "Premium", "Effective", "Expires"], ...ins.map((p: any) => [p.kind, p.carrier, p.policy_no, p.limits, p.deductible, p.premium, p.effective_on, p.expires_on])]));
        for (const p of ins) if (p.documents) { try { folder("06 Insurance").file(p.documents.name, await storage.download("vault", p.documents.file_path)); } catch { /* skip */ } }
        index.push(["06 Insurance", `${ins.length} policies with limits and renewal dates`]);
      }
      if (incl.docs) {
        step("Legal, tax and financial documents");
        const docs = await db.get<any>(`documents?select=*&folder=in.(legal,tax,financials,loan,contracts)&or=(hotel_id.eq.${hotelId},hotel_id.is.null)&investor_id=is.null&order=folder.asc`);
        for (const d of docs) { try { folder(`07 Documents/${FOLDERS.find((f) => f[0] === d.folder)?.[1] || d.folder}`).file(d.name, await storage.download("vault", d.file_path)); } catch { /* skip */ } }
        index.push(["07 Documents", `${docs.length} files from the vault (legal, tax, financial statements, contracts)`]);
      }
      if (incl.pfs) {
        step("Personal financial statement");
        const p = (await db.get<any>(`pfs_statements?select=*&order=updated_at.desc&limit=1`))[0];
        if (p) { zip.file("08 Personal Financial Statement.pdf", await pfsPdf(p, brand)); index.push(["08 Personal Financial Statement.pdf", `As of ${fmtDate(p.as_of)} — confidential`]); }
        else step("  (no PFS saved yet — skipped)");
      }
      step("Cover page and index");
      zip.file("00 Cover & Index.pdf", await buildPdf({ title: `Loan Package — ${hotel.name}`, subtitle: `${[hotel.city, hotel.state].filter(Boolean).join(", ")} · ${hotel.rooms} rooms · prepared ${fmtDate(todayIn())}`, brand, accent: ctx.tenant.accent_color || undefined,
        blocks: [{ h: "Contents" }, { table: { head: ["File", "What it contains"], rows: index, widths: [1.4, 2], align: ["l", "l"] } },
          { p: `Prepared by ${brand} from its hotel operations platform. Figures are unaudited management numbers unless stated otherwise.`, muted: true, size: 8.5 }] }));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      downloadFile(`Loan Package - ${hotel.name} - ${todayIn()}.zip`, blob, "application/zip");
      step(`Done · ${(blob.size / 1e6).toFixed(1)} MB downloaded`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHead eyebrow="Capital" title="Loan Package" desc="Everything a lender asks for, gathered and organised into one ZIP file with a single click." />
      <div className="grid g-2-1">
        <Card title="Build the package">
          <div className="fgrid">
            <Field label="Hotel" id="lpH"><HotelSelect hotels={ctx.hotels} value={hotelId} onChange={setHotelId} id="lpH" /></Field>
            <Field label="Operating history" id="lpM"><select id="lpM" value={months} onChange={(e) => setMonths(e.target.value as any)}><option value="12">12 months</option><option value="24">24 months</option><option value="36">36 months</option></select></Field>
          </div>
          <fieldset className="hotel-picks" style={{ marginTop: 14 }}><legend>Include</legend>
            {([["str", "STR market performance"], ["budget", "Current-year budget vs actual"], ["permits", "Permits & licences (with copies)"], ["insurance", "Insurance schedule (with policies)"], ["docs", "Legal, tax & financial documents from the vault"], ["pfs", "My personal financial statement"]] as [keyof typeof incl, string][]).map(([k, l]) => (
              <label key={k} className="check-row" htmlFor={"lp" + String(k)}><input id={"lp" + String(k)} type="checkbox" checked={incl[k]} onChange={(e) => setIncl({ ...incl, [k]: e.target.checked })} />{l}</label>
            ))}
          </fieldset>
          <button className="btn pri wide" style={{ marginTop: 16, minHeight: 48 }} disabled={busy || !hotel} onClick={build}>{busy ? "Building…" : "Build & download ZIP"}</button>
          {err && <Notice kind="bad">{err}</Notice>}
        </Card>
        <Card title="Progress">
          {log.length ? <ul className="plain">{log.map((l, i) => <li key={i} className="small">{l}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>The package is assembled in your browser from live data and the document vault. Nothing is emailed or shared until you send the ZIP yourself.</p>}
        </Card>
      </div>
    </>
  );
}

// ======================= Personal financial statement =======================
const PFS_ASSETS: [string, string][] = [["cash", "Cash on hand & in banks"], ["savings", "Savings accounts"], ["retirement", "IRA / retirement accounts"], ["receivables", "Accounts & notes receivable"],
  ["life_cash", "Life insurance — cash surrender value"], ["securities", "Stocks & bonds"], ["real_estate", "Real estate (from schedule)"], ["autos", "Automobiles"], ["personal", "Other personal property"], ["business", "Business interests (hotel ownership)"], ["other_assets", "Other assets"]];
const PFS_LIABS: [string, string][] = [["payables", "Accounts payable"], ["notes_banks", "Notes payable to banks & others"], ["auto_loans", "Installment account — auto"], ["installment", "Installment account — other"],
  ["life_loans", "Loans on life insurance"], ["mortgages", "Mortgages on real estate (from schedule)"], ["taxes", "Unpaid taxes"], ["other_liabs", "Other liabilities"]];
const PFS_INCOME: [string, string][] = [["salary", "Salary"], ["investment", "Net investment income"], ["re_income", "Real estate income"], ["other_income", "Other income"]];
const PFS_CONT: [string, string][] = [["endorser", "As endorser or co-maker"], ["legal", "Legal claims & judgments"], ["fed_tax", "Provision for federal income tax"], ["guarantees", "Personal guarantees (e.g. hotel loans)"], ["other_cont", "Other special debt"]];
type Pfs = { id?: string; as_of: string; title: string; data: any };
function pfsTotals(d: any) {
  const n = (k: string) => Number(d?.[k] || 0);
  const re = (d?.properties || []) as any[];
  const reVal = re.reduce((a, p) => a + Number(p.value || 0), 0), reMort = re.reduce((a, p) => a + Number(p.mortgage || 0), 0);
  const assets = PFS_ASSETS.reduce((a, [k]) => a + (k === "real_estate" ? reVal : n(k)), 0);
  const liabs = PFS_LIABS.reduce((a, [k]) => a + (k === "mortgages" ? reMort : n(k)), 0);
  return { assets, liabs, net: assets - liabs, reVal, reMort };
}
async function pfsPdf(p: Pfs, brand: string) {
  const d = p.data || {}; const t = pfsTotals(d);
  const v = (k: string) => (k === "real_estate" ? t.reVal : k === "mortgages" ? t.reMort : Number(d[k] || 0));
  return buildPdf({ title: "Personal Financial Statement", subtitle: `${d.name || ""} · as of ${fmtDate(p.as_of)} · CONFIDENTIAL`, brand, blocks: [
    { kv: [["Name", d.name || ""], ["Address", d.address || ""], ["Phone", d.phone || ""], ["Business", d.business || ""], ["Statement date", fmtDate(p.as_of)]] },
    { h: "Assets" }, { table: { head: ["Asset", "Amount"], rows: [...PFS_ASSETS.map(([k, l]) => [l, money(v(k))]), ["Total assets", money(t.assets)]], widths: [3, 1] } },
    { h: "Liabilities" }, { table: { head: ["Liability", "Amount"], rows: [...PFS_LIABS.map(([k, l]) => [l, money(v(k))]), ["Total liabilities", money(t.liabs)], ["Net worth", money(t.net)]], widths: [3, 1] } },
    { h: "Annual income" }, { table: { head: ["Source", "Amount"], rows: PFS_INCOME.map(([k, l]) => [l, money(Number(d[k] || 0))]), widths: [3, 1] } },
    { h: "Contingent liabilities" }, { table: { head: ["Item", "Amount"], rows: PFS_CONT.map(([k, l]) => [l, money(Number(d[k] || 0))]), widths: [3, 1] } },
    { h: "Real estate owned" }, { table: { head: ["Property", "Type", "Acquired", "Cost", "Present value", "Mortgage", "Lender"], rows: (d.properties || []).map((r: any) => [r.address, r.type, r.acquired, money(Number(r.cost || 0)), money(Number(r.value || 0)), money(Number(r.mortgage || 0)), r.lender]), widths: [2.2, 1, 0.9, 1, 1.1, 1, 1.3] } },
    { space: 18 }, { p: "I certify that the above information is true and complete to the best of my knowledge.", size: 9 },
    { space: 26 }, { p: "Signature ______________________________________        Date ________________", size: 9.5 },
  ] });
}
export function PfsPage({ ctx }: { ctx: Ctx }) {
  const q = useAsync(() => db.get<Pfs>(`pfs_statements?select=*&order=updated_at.desc&limit=1`), []);
  const [p, setP] = useState<Pfs | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const cur: Pfs = p || q.data?.[0] || { as_of: todayIn(), title: "Personal Financial Statement", data: { name: "", properties: [] } };
  const d = cur.data || {};
  const set = (k: string, v: any) => setP({ ...cur, data: { ...d, [k]: v } });
  const t = pfsTotals(d);
  async function save() {
    try {
      const row = { as_of: cur.as_of, title: cur.title, data: cur.data, tenant_id: ctx.tenant.id, updated_at: new Date().toISOString() };
      const r = cur.id ? await db.update<Pfs>("pfs_statements", `id=eq.${cur.id}`, row) : await db.insert<Pfs>("pfs_statements", row);
      setP(r[0]); setMsg({ kind: "good", text: "Saved. Only you can see this statement." });
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  const num = (k: string, l: string, ro?: number) => (
    <Field key={k} label={l} id={"pfs" + k}><input id={"pfs" + k} inputMode="decimal" readOnly={ro !== undefined} value={ro !== undefined ? Math.round(ro).toLocaleString() : d[k] ?? ""} onChange={(e) => set(k, e.target.value.replace(/[^\d.]/g, ""))} /></Field>
  );
  const props = (d.properties || []) as any[];
  return (
    <>
      <PageHead eyebrow="Capital" title="Personal Financial Statement" desc="Your PFS for lenders. It is private to your login — no one else in the company, including administrators, can see it. Don't enter Social Security numbers here."
        actions={<><button className="btn" onClick={async () => downloadFile(`Personal Financial Statement ${cur.as_of}.pdf`, (await pfsPdf(cur, ctx.tenant.brand_name || ctx.tenant.name)) as BlobPart, "application/pdf")}>Download PDF</button><button className="btn pri" onClick={save}>Save</button></>} />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.data && (
        <>
          <div className="stat-row">
            <Kpi label="Total assets" value={usd(t.assets)} />
            <Kpi label="Total liabilities" value={usd(t.liabs)} />
            <Kpi label="Net worth" value={<span style={{ color: t.net >= 0 ? "var(--good)" : "var(--bad)" }}>{usd(t.net)}</span>} />
          </div>
          <div className="grid g2">
            <Card title="About you">
              <div className="fgrid">
                <Field label="Full name" id="pfsName"><input id="pfsName" value={d.name || ""} onChange={(e) => set("name", e.target.value)} /></Field>
                <Field label="Statement date" id="pfsAsOf"><input id="pfsAsOf" type="date" value={cur.as_of} onChange={(e) => setP({ ...cur, as_of: e.target.value })} /></Field>
                <Field label="Home address" id="pfsAddr"><input id="pfsAddr" value={d.address || ""} onChange={(e) => set("address", e.target.value)} /></Field>
                <Field label="Phone" id="pfsPhone"><input id="pfsPhone" value={d.phone || ""} onChange={(e) => set("phone", e.target.value)} /></Field>
                <Field label="Business name" id="pfsBiz" span><input id="pfsBiz" value={d.business || ""} onChange={(e) => set("business", e.target.value)} /></Field>
              </div>
            </Card>
            <Card title="Annual income"><div className="fgrid">{PFS_INCOME.map(([k, l]) => num(k, l))}</div></Card>
            <Card title="Assets"><div className="fgrid">{PFS_ASSETS.map(([k, l]) => num(k, l, k === "real_estate" ? t.reVal : undefined))}</div></Card>
            <Card title="Liabilities"><div className="fgrid">{PFS_LIABS.map(([k, l]) => num(k, l, k === "mortgages" ? t.reMort : undefined))}</div></Card>
            <Card title="Contingent liabilities"><div className="fgrid">{PFS_CONT.map(([k, l]) => num(k, l))}</div></Card>
          </div>
          <div className="sp" />
          <Card title="Real estate owned" actions={<button className="btn sm" onClick={() => set("properties", [...props, { address: "", type: "", acquired: "", cost: "", value: "", mortgage: "", lender: "" }])}>Add property</button>} flush>
            {props.length ? <div className="tw"><table>
              <thead><tr><th>Address</th><th>Type</th><th>Acquired</th><th className="n">Cost</th><th className="n">Present value</th><th className="n">Mortgage</th><th>Lender</th><th></th></tr></thead>
              <tbody>{props.map((r, i) => {
                const s = (k: string, v: string) => set("properties", props.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
                return <tr key={i}>{(["address", "type", "acquired", "cost", "value", "mortgage", "lender"] as const).map((k) => <td key={k}><input aria-label={k} value={r[k] || ""} onChange={(e) => s(k, e.target.value)} style={{ width: k === "address" ? 200 : 110 }} /></td>)}
                  <td><button className="btn sm" aria-label="Remove property" onClick={() => set("properties", props.filter((_, j) => j !== i))}>×</button></td></tr>;
              })}</tbody></table></div> : <Empty title="No properties listed." />}
          </Card>
          <p className="small muted">This is a general PFS layout. If a lender requires its own form (for example SBA Form 413), use PDF Form Filler to fill their form from these numbers.</p>
        </>
      )}
    </>
  );
}

// ======================= Construction =======================
const DRAW_PILL: Record<string, "good" | "warn" | "info" | "mute" | "bad"> = { funded: "good", inspected: "info", requested: "warn", draft: "mute", rejected: "bad" };
export function Construction({ ctx }: { ctx: Ctx }) {
  const dev = ctx.hotels.filter((h) => h.status === "development");
  const [hotelId, setHotelId] = useState(dev[0]?.id || "");
  const hotel = ctx.hotels.find((h) => h.id === hotelId);
  const canEdit = ctx.can("construction", "edit");
  const q = useAsync(async () => {
    if (!hotelId) return null;
    const [b, m, d, co] = await Promise.all([
      db.get<any>(`construction_budget?select=*&hotel_id=eq.${hotelId}&order=sort.asc`),
      db.get<any>(`construction_milestones?select=*&hotel_id=eq.${hotelId}&order=sort.asc`),
      db.get<any>(`construction_draws?select=*&hotel_id=eq.${hotelId}&order=draw_no.asc`),
      db.get<any>(`change_orders?select=*&hotel_id=eq.${hotelId}&order=co_no.asc`),
    ]);
    return { b, m, d, co };
  }, [hotelId]);
  const [edit, setEdit] = useState<{ kind: "line" | "draw" | "milestone" | "co"; row: any } | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const T = (k: string) => (q.data?.b || []).reduce((a: number, r: any) => a + Number(r[k]), 0);
  const budget = T("budget"), committed = T("committed"), spent = T("spent");
  const coApproved = (q.data?.co || []).filter((c: any) => c.status === "approved").reduce((a: number, c: any) => a + Number(c.amount), 0);
  const funded = (q.data?.d || []).filter((x: any) => x.status === "funded").reduce((a: number, x: any) => a + Number(x.amount), 0);
  const daysToOpen = hotel?.opening_date ? Math.round((Date.parse(hotel.opening_date) - Date.now()) / 864e5) : null;
  const cats = useMemo(() => { const m = new Map<string, any[]>(); (q.data?.b || []).forEach((r: any) => m.set(r.category, [...(m.get(r.category) || []), r])); return [...m.entries()]; }, [q.data]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const table = { line: "construction_budget", draw: "construction_draws", milestone: "construction_milestones", co: "change_orders" }[edit.kind];
    try {
      const { id, data_source, tenant_id, ...row } = edit.row;
      for (const k of ["budget", "committed", "spent", "amount"]) if (k in row) row[k] = Number(row[k] || 0);
      for (const k of ["actual_on", "planned_on", "funded_on"]) if (k in row && !row[k]) row[k] = null;
      if (id) await db.update(table, `id=eq.${id}`, row, "id"); else await db.insert(table, { ...row, tenant_id: ctx.tenant.id, hotel_id: hotelId }, "id");
      setEdit(null); q.reload();
    } catch (err: any) { setMsg({ kind: "bad", text: err.message }); }
  }
  if (!dev.length) return <><PageHead eyebrow="Construction" title="Development Projects" /><Empty title="No hotels in development.">Set a hotel's status to development to track its construction here.</Empty></>;
  return (
    <>
      <PageHead eyebrow="Construction" title="Development Projects" desc="A separate workspace for new builds: budget vs committed vs spent, lender draws, milestones and change orders."
        actions={<button className="btn" onClick={() => q.data && downloadFile(`construction-budget_${hotel?.name}.csv`, toCsv([["Category", "Line", "Budget", "Committed", "Spent", "Remaining"], ...q.data.b.map((r: any) => [r.category, r.line, r.budget, r.committed, r.spent, Number(r.budget) - Number(r.spent)])]))}>Export budget</button>} />
      <div className="toolbar"><HotelSelect hotels={dev} value={hotelId} onChange={setHotelId} />{hotel?.opening_date && <span className="small muted">Opening {fmtDate(hotel.opening_date)} · {hotel.rooms} rooms</span>}</div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (
        <>
          <div className="kpis">
            <Kpi label="Total budget" value={usdShort(budget + coApproved)} delta={<span className="tag">{usdShort((budget + coApproved) / (hotel?.rooms || 1))} per key</span>} />
            <Kpi label="Committed" value={usdShort(committed)} delta={<span className="tag">{pct(committed / (budget || 1))} of budget</span>} />
            <Kpi label="Spent to date" value={usdShort(spent)} delta={<span className="tag">{pct(spent / (budget || 1))} of budget</span>} />
            <Kpi label="Lender funded" value={usdShort(funded)} />
            <Kpi label="Change orders" value={usdShort(coApproved)} delta={<span className="tag">{(q.data.co || []).filter((c: any) => c.status === "pending").length} pending</span>} />
            <Kpi label="Days to opening" value={daysToOpen ?? "—"} />
          </div>
          <div className="grid g-2-1">
            <Card title="Budget" flush actions={canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "line", row: { category: "Hard costs", line: "", budget: "", committed: "", spent: "", sort: 99 } })}>Add line</button>}>
              <div className="tw"><table>
                <thead><tr><th>Line</th><th className="n">Budget</th><th className="n">Committed</th><th className="n">Spent</th><th style={{ width: 140 }}>Progress</th><th></th></tr></thead>
                <tbody>{cats.map(([cat, rows]) => (
                  <React.Fragment key={cat}>
                    <tr><td colSpan={6} className="tag" style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", paddingTop: 12 }}>{cat}</td></tr>
                    {rows.map((r: any) => (
                      <tr key={r.id}>
                        <td className="small">{r.line} <SampleBadge show={r.data_source === "sample"} /></td>
                        <td className="n">{usd(Number(r.budget))}</td><td className="n">{usd(Number(r.committed))}</td><td className="n">{usd(Number(r.spent))}</td>
                        <td><div className="prog" title={`${pct(Number(r.spent) / (Number(r.budget) || 1))} spent`}><span style={{ width: `${Math.min(100, (Number(r.spent) / (Number(r.budget) || 1)) * 100)}%`, background: "var(--accent)" }} /><span style={{ width: `${Math.max(0, Math.min(100, ((Number(r.committed) - Number(r.spent)) / (Number(r.budget) || 1)) * 100))}%`, background: "color-mix(in srgb, var(--accent) 35%, transparent)" }} /></div></td>
                        <td>{canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "line", row: { ...r } })}>Edit</button>}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                  <tr style={{ fontWeight: 700, background: "var(--surface-2)" }}><td>Total</td><td className="n">{usd(budget)}</td><td className="n">{usd(committed)}</td><td className="n">{usd(spent)}</td><td></td><td></td></tr>
                </tbody>
              </table></div>
            </Card>
            <div className="grid" style={{ alignContent: "start" }}>
              <Card title="Milestones" flush actions={canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "milestone", row: { name: "", planned_on: "", status: "planned", sort: 99 } })}>Add</button>}>
                <div className="timeline">{q.data.m.map((m: any) => (
                  <button type="button" key={m.id} className={"tl " + m.status} onClick={() => canEdit && setEdit({ kind: "milestone", row: { ...m } })} disabled={!canEdit}>
                    <i /><div><b className="small">{m.name}</b><div className="tag">{m.actual_on ? `Done ${fmtDate(m.actual_on)}` : m.planned_on ? `Planned ${fmtDate(m.planned_on)}` : ""}</div></div>
                  </button>
                ))}</div>
              </Card>
            </div>
          </div>
          <div className="sp" />
          <div className="grid g2">
            <Card title="Lender draws" flush actions={canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "draw", row: { draw_no: (q.data!.d.length || 0) + 1, requested_on: todayIn(), amount: "", status: "draft", lender: q.data!.d[0]?.lender || "" } })}>New draw</button>}>
              {q.data.d.length ? <div className="tw"><table>
                <thead><tr><th>#</th><th>Requested</th><th className="n">Amount</th><th>Status</th><th>Funded</th><th></th></tr></thead>
                <tbody>{q.data.d.map((x: any) => <tr key={x.id}><td>{x.draw_no}</td><td className="small">{fmtDate(x.requested_on)}</td><td className="n">{usd(Number(x.amount))}</td><td><Pill kind={DRAW_PILL[x.status]}>{x.status}</Pill></td><td className="small">{x.funded_on ? fmtDate(x.funded_on) : "—"}</td><td>{canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "draw", row: { ...x } })}>Edit</button>}</td></tr>)}</tbody>
              </table></div> : <Empty title="No draws yet." />}
            </Card>
            <Card title="Change orders" flush actions={canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "co", row: { co_no: (q.data!.co.length || 0) + 1, description: "", amount: "", status: "pending", requested_on: todayIn() } })}>New change order</button>}>
              {q.data.co.length ? <div className="tw"><table>
                <thead><tr><th>#</th><th>Description</th><th className="n">Amount</th><th>Status</th><th></th></tr></thead>
                <tbody>{q.data.co.map((c: any) => <tr key={c.id}><td>{c.co_no}</td><td className="small">{c.description}</td><td className="n">{usd(Number(c.amount))}</td><td><Pill kind={c.status === "approved" ? "good" : c.status === "rejected" ? "bad" : "warn"}>{c.status}</Pill></td><td>{canEdit && <button className="btn sm" onClick={() => setEdit({ kind: "co", row: { ...c } })}>Edit</button>}</td></tr>)}</tbody>
              </table></div> : <Empty title="No change orders." />}
            </Card>
          </div>
        </>
      )}
      {edit && (
        <Modal title={{ line: "Budget line", draw: "Lender draw", milestone: "Milestone", co: "Change order" }[edit.kind]} onClose={() => setEdit(null)} onSubmit={save}
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn pri">Save</button></>}>
          <div className="fgrid">
            {edit.kind === "line" && <>
              <Field label="Category" id="cC"><select id="cC" value={edit.row.category} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, category: e.target.value } })}>{["Land & site", "Hard costs", "Soft costs", "FF&E", "OS&E", "Financing", "Contingency"].map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Line" id="cL"><input id="cL" required value={edit.row.line} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, line: e.target.value } })} /></Field>
              {(["budget", "committed", "spent"] as const).map((k) => <Field key={k} label={k[0].toUpperCase() + k.slice(1) + " ($)"} id={"c" + k}><input id={"c" + k} type="number" min="0" step="0.01" value={edit.row[k]} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, [k]: e.target.value } })} /></Field>)}
            </>}
            {edit.kind === "draw" && <>
              <Field label="Draw #" id="dN"><input id="dN" type="number" min="1" value={edit.row.draw_no} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, draw_no: Number(e.target.value) } })} /></Field>
              <Field label="Amount ($)" id="dAm"><input id="dAm" type="number" min="0" step="0.01" required value={edit.row.amount} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, amount: e.target.value } })} /></Field>
              <Field label="Requested" id="dR"><input id="dR" type="date" value={edit.row.requested_on} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, requested_on: e.target.value } })} /></Field>
              <Field label="Status" id="dS"><select id="dS" value={edit.row.status} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, status: e.target.value, funded_on: e.target.value === "funded" && !edit.row.funded_on ? todayIn() : edit.row.funded_on } })}>{["draft", "requested", "inspected", "funded", "rejected"].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Lender" id="dL"><input id="dL" value={edit.row.lender || ""} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, lender: e.target.value } })} /></Field>
              <Field label="Funded on" id="dF"><input id="dF" type="date" value={edit.row.funded_on || ""} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, funded_on: e.target.value } })} /></Field>
            </>}
            {edit.kind === "milestone" && <>
              <Field label="Milestone" id="mN"><input id="mN" required value={edit.row.name} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, name: e.target.value } })} /></Field>
              <Field label="Planned" id="mP"><input id="mP" type="date" value={edit.row.planned_on || ""} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, planned_on: e.target.value } })} /></Field>
              <Field label="Completed" id="mA"><input id="mA" type="date" value={edit.row.actual_on || ""} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, actual_on: e.target.value, status: e.target.value ? "done" : edit.row.status } })} /></Field>
              <Field label="Status" id="mS"><select id="mS" value={edit.row.status} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, status: e.target.value } })}>{["planned", "in_progress", "done", "late"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></Field>
            </>}
            {edit.kind === "co" && <>
              <Field label="CO #" id="coN"><input id="coN" type="number" min="1" value={edit.row.co_no} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, co_no: Number(e.target.value) } })} /></Field>
              <Field label="Amount ($)" id="coA"><input id="coA" type="number" step="0.01" required value={edit.row.amount} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, amount: e.target.value } })} /></Field>
              <Field label="Description" id="coD" span><input id="coD" required value={edit.row.description} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, description: e.target.value } })} /></Field>
              <Field label="Status" id="coS"><select id="coS" value={edit.row.status} onChange={(e) => setEdit({ ...edit, row: { ...edit.row, status: e.target.value } })}>{["pending", "approved", "rejected"].map((s) => <option key={s}>{s}</option>)}</select></Field>
            </>}
          </div>
        </Modal>
      )}
    </>
  );
}
