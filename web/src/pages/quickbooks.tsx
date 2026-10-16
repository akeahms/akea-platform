import React, { useMemo, useState } from "react";
import { db, callFunction } from "../lib/sb";
import { Ctx, usd, fmtDate } from "../lib/app";
import { Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, HotelSelect, Notice, Seg } from "../ui";

// QuickBooks Online: each hotel connects to its own QuickBooks company. Akea sends the nightly revenue journal,
// approved bills (creating vendors as needed), bill payments and manual journal entries; nothing is ever sent twice.
type QStatus = { hotel_id: string; realm_id: string; company_name: string | null; status: string; last_error: string | null; last_synced_at: string | null; refresh_expires_at: string | null };
const NEEDED = new Set(["cash", "card_clearing", "guest_ledger", "ar_direct_bill", "sales_tax", "room_revenue", "fnb_revenue", "other_revenue", "default_expense"]);  // account roles used by the nightly revenue journal and default bill/payment postings
const TYPE_LABEL: Record<string, string> = { daily_revenue: "Night audit revenue", bill: "Bill", bill_payment: "Bill payment", journal: "Journal entry" };
const BANNER: Record<string, [string, "good" | "bad" | "info"]> = {
  connected: ["QuickBooks is connected. Check the account mapping below, then press Sync now (or wait for tonight's automatic run).", "good"],
  cancelled: ["QuickBooks sign-in was cancelled. Nothing changed.", "info"],
  failed: ["QuickBooks didn't finish connecting. Please try again.", "bad"],
  expired: ["That QuickBooks sign-in link expired. Start again with Connect to QuickBooks.", "bad"],
};

export function QuickBooks({ ctx }: { ctx: Ctx }) {
  const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(params.get("hotel") || operating[0]?.id || "");
  const [banner, setBanner] = useState<[string, "good" | "bad" | "info"] | null>(BANNER[params.get("qbo") || ""] || null);
  const canSync = ctx.can("finance", "edit"), canAdmin = ctx.can("finance", "approve");
  const cfg = useAsync(() => callFunction<any>("quickbooks", { action: "config" }).catch(() => ({ configured: false })), []);
  const st = useAsync(() => db.rpc<QStatus[]>("qbo_status", { p_hotels: [hotelId] }).then((r) => r[0] || null), [hotelId]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [logView, setLogView] = useState<"problems" | "all">("problems");
  const hotel = ctx.hotels.find((h) => h.id === hotelId);
  const c = st.data;

  const data = useAsync(async () => {
    if (!c) return null;
    const [gls, qas, maps, settings, log] = await Promise.all([
      db.get<any>(`gl_accounts?select=id,number,name,full_name,type,active,system_key&hotel_id=eq.${hotelId}&order=number.asc`),
      db.get<any>(`qbo_accounts?select=qbo_id,name,full_name,acct_num,account_type&hotel_id=eq.${hotelId}&order=full_name.asc`),
      db.get<any>(`qbo_account_map?select=gl_account_id,qbo_account_id&hotel_id=eq.${hotelId}`),
      db.get<any>(`qbo_settings?select=*&hotel_id=eq.${hotelId}`),
      db.get<any>(`qbo_sync_log?select=*&hotel_id=eq.${hotelId}&order=updated_at.desc&limit=200`),
    ]);
    const map = new Map<string, string>(maps.map((m: any) => [m.gl_account_id, m.qbo_account_id] as [string, string]));
    // inactive accounts are listed only if they were mapped before (their history may still need to go out)
    return { gls: gls.filter((g: any) => g.active || map.has(g.id)), qas, map, settings: settings[0] || null, log };
  }, [hotelId, c?.realm_id, c?.last_synced_at]);

  async function call(action: string, extra: Record<string, unknown> = {}) { return callFunction<any>("quickbooks", { action, hotel_id: hotelId, ...extra }); }
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg(null);
    try { await fn(); } catch (e: any) { setMsg({ kind: "bad", text: e.message }); st.reload(); } finally { setBusy(""); }
  }
  const connect = () => run("connect", async () => { const { url } = await call("connect_url"); window.location.href = url; });
  const sync = () => run("sync", async () => {
    const r = await call("sync");
    const parts = [`${r.synced} sent to QuickBooks`, r.needs_mapping ? `${r.needs_mapping} waiting for account mapping` : "", r.failed ? `${r.failed} failed (see the log)` : ""].filter(Boolean);
    setMsg({ kind: r.failed || r.needs_mapping ? "info" : "good", text: r.synced + r.failed + r.needs_mapping ? parts.join(", ") + "." : "Everything is already in QuickBooks." });
    st.reload(); data.reload();
  });
  const refreshAccounts = () => run("accounts", async () => { const r = await call("refresh_accounts"); setMsg({ kind: "good", text: `Loaded ${r.accounts} QuickBooks accounts.` }); data.reload(); });
  const autoMap = () => run("automap", async () => { const r = await call("auto_map"); setMsg({ kind: "good", text: `Matched ${r.matched} accounts automatically${r.unmatched > 0 ? `; ${r.unmatched} still need a choice below` : ""}.` }); data.reload(); });
  const disconnect = () => run("off", async () => { await call("disconnect"); setConfirmOff(false); setMsg({ kind: "good", text: "QuickBooks disconnected. Nothing already sent was changed in QuickBooks." }); st.reload(); });
  async function setMap(glId: string, qboId: string) {
    try {
      if (qboId) await db.upsert("qbo_account_map", { hotel_id: hotelId, tenant_id: ctx.tenant.id, gl_account_id: glId, qbo_account_id: qboId, updated_at: new Date().toISOString() }, "hotel_id,gl_account_id", "gl_account_id");
      else await db.remove("qbo_account_map", `hotel_id=eq.${hotelId}&gl_account_id=eq.${glId}`);
      data.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }
  async function saveSettings(patch: Record<string, unknown>) {
    try {
      await db.upsert("qbo_settings", { hotel_id: hotelId, tenant_id: ctx.tenant.id, ...(data.data?.settings || {}), ...patch, updated_at: new Date().toISOString() }, "hotel_id", "hotel_id");
      data.reload();
    } catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
  }

  const d = data.data;
  const unmappedNeeded = useMemo(() => (d ? d.gls.filter((g: any) => NEEDED.has(g.system_key) && !d.map.get(g.id)) : []), [d]);
  const problems = (d?.log || []).filter((l: any) => l.status !== "synced");
  const shownLog = logView === "problems" ? problems : d?.log || [];
  const pill: [string, "good" | "warn" | "bad" | "mute"] | null = c ? (c.status === "active" ? ["Connected", "good"] : c.status === "needs_relogin" ? ["Sign in to QuickBooks again", "bad"] : ["Sync problem", "bad"]) : null;
  const s = d?.settings || { start_date: new Date().toISOString().slice(0, 10), push_daily_revenue: true, push_bills: true, push_payments: true, push_journals: true };

  return (
    <>
      <div className="toolbar"><HotelSelect hotels={operating} value={hotelId} onChange={(v) => { setHotelId(v); setMsg(null); }} /></div>
      {banner && <Notice kind={banner[1]} onClose={() => setBanner(null)}>{banner[0]}</Notice>}
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {(st.loading && !st.data && !st.error) || cfg.loading ? <Loading /> : st.error ? <ErrorBox error={st.error} retry={st.reload} /> : (
        <div className="grid g-2-1">
          <div className="grid" style={{ alignContent: "start" }}>
            <Card title={`QuickBooks · ${hotel?.name || ""}`} actions={pill ? <Pill kind={pill[1]}>{pill[0]}</Pill> : undefined}>
              {!c ? (
                <>
                  <p className="small" style={{ marginTop: 0 }}>Connect this hotel's QuickBooks Online company. Every morning Akea sends last night's revenue journal, approved bills, bill payments and journal entries, so the books stay current without re-keying.</p>
                  {!cfg.data?.configured ? <p className="small muted">QuickBooks isn't switched on yet. An administrator adds the Intuit app keys once (Supabase → Edge Functions → Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV).</p>
                    : canAdmin ? <button className="btn pri" disabled={!!busy} onClick={connect}>{busy === "connect" ? "Opening Intuit…" : "Connect to QuickBooks"}</button>
                    : <p className="small muted">Someone with finance approval rights can connect QuickBooks.</p>}
                  {cfg.data?.environment === "sandbox" && cfg.data?.configured && <p className="tag">Test mode: connects to an Intuit sandbox company.</p>}
                </>
              ) : (
                <>
                  <div className="small">
                    <b>{c.company_name || "QuickBooks company"}</b> <span className="muted">· company ID {c.realm_id}</span>
                    <div className="muted">{c.last_synced_at ? `Last sent ${new Date(c.last_synced_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Nothing sent yet"} · sends automatically every morning at 6:45 AM Central</div>
                    {c.refresh_expires_at && <div className="muted">Connection renews itself; it lapses only if unused until {fmtDate(c.refresh_expires_at.slice(0, 10))}</div>}
                  </div>
                  {c.last_error && <Notice kind={c.status === "active" ? "info" : "bad"}>{c.last_error}</Notice>}
                  {!!unmappedNeeded.length && <Notice kind="info">Map {unmappedNeeded.length} account{unmappedNeeded.length === 1 ? "" : "s"} used by the nightly revenue journal before the first sync: {unmappedNeeded.map((g: any) => `${g.number} ${g.name}`).join(", ")}.</Notice>}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {canSync && c.status !== "needs_relogin" && <button className="btn sm pri" disabled={!!busy} onClick={sync}>{busy === "sync" ? "Sending…" : "Sync now"}</button>}
                    {canAdmin && c.status === "needs_relogin" && <button className="btn sm pri" disabled={!!busy} onClick={connect}>Reconnect</button>}
                    {canSync && <button className="btn sm" disabled={!!busy} onClick={refreshAccounts}>{busy === "accounts" ? "Loading…" : "Reload QuickBooks accounts"}</button>}
                    {canAdmin && <button className="btn sm" disabled={!!busy} onClick={() => setConfirmOff(true)} style={{ color: "var(--bad)" }}>Disconnect</button>}
                  </div>
                </>
              )}
            </Card>

            {c && d && (
              <Card title="Account mapping" actions={canAdmin ? <button className="btn sm" disabled={!!busy || !d.qas.length} onClick={autoMap}>{busy === "automap" ? "Matching…" : "Auto-match"}</button> : undefined}
                note="Which QuickBooks account each Akea account posts to. Starred accounts are used by the nightly revenue journal.">
                {!d.qas.length ? <Empty title="No QuickBooks accounts loaded.">Press Reload QuickBooks accounts.</Empty> : (
                  <div className="tw"><table>
                    <thead><tr><th>Akea account</th><th>QuickBooks account</th></tr></thead>
                    <tbody>{d.gls.map((g: any) => {
                      const v = d.map.get(g.id) || "";
                      return (
                        <tr key={g.id}>
                          <td className="small"><b>{g.number}</b> {g.full_name || g.name}{!g.active && " (Inactive)"}{NEEDED.has(g.system_key) && <span title="Used by the nightly revenue journal" style={{ color: "var(--accent)" }}> ★</span>}</td>
                          <td style={{ minWidth: 220 }}>
                            <select aria-label={`QuickBooks account for ${g.number} ${g.name}`} value={v} disabled={!canAdmin} onChange={(e) => setMap(g.id, e.target.value)}
                              style={!v && NEEDED.has(g.system_key) ? { borderColor: "var(--bad)" } : undefined}>
                              <option value="">Not mapped</option>
                              {d.qas.map((q: any) => <option key={q.qbo_id} value={q.qbo_id}>{q.acct_num ? `${q.acct_num} · ` : ""}{q.full_name || q.name} ({q.account_type})</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}</tbody>
                  </table></div>
                )}
              </Card>
            )}
          </div>

          {c && d && (
            <div className="grid" style={{ alignContent: "start" }}>
              <Card title="What gets sent">
                <div className="field"><label htmlFor="qStart">Send activity from</label>
                  <input id="qStart" type="date" value={s.start_date} disabled={!canAdmin} onChange={(e) => e.target.value && saveSettings({ start_date: e.target.value })} />
                  <span className="tag">Nothing dated before this is sent. Use the day after your last closed month in QuickBooks.</span></div>
                {([["push_daily_revenue", "Night audit revenue", "One journal a day: revenue and tax credited; card, cash and direct-bill payments debited; the rest to guest ledger"],
                  ["push_bills", "Approved bills", "Vendors are created in QuickBooks when they don't exist yet"],
                  ["push_payments", "Bill payments", "Linked to the bill, from the mapped bank account"],
                  ["push_journals", "Manual journal entries", "Entries made by hand in Akea's journal"]] as const).map(([k, label, hint]) => (
                  <label key={k} className="check-row" htmlFor={"q-" + k}>
                    <input id={"q-" + k} type="checkbox" checked={!!(s as any)[k]} disabled={!canAdmin} onChange={(e) => saveSettings({ [k]: e.target.checked })} />
                    <span><b>{label}</b><span className="tag" style={{ display: "block" }}>{hint}</span></span>
                  </label>
                ))}
              </Card>
              <Card title="Sync log" flush actions={<Seg label="Show" value={logView} onChange={setLogView} options={[["problems", `Needs attention (${problems.length})`], ["all", "All"]]} />}>
                {shownLog.length ? (
                  <div className="list">{shownLog.slice(0, 60).map((l: any) => (
                    <div className="li" key={l.id}><div style={{ minWidth: 0 }}>
                      <div className="t">{l.label || TYPE_LABEL[l.object_type]} {l.amount != null && <span className="muted">· {usd(Number(l.amount), 2)}</span>}</div>
                      <div className="s">{TYPE_LABEL[l.object_type]} · {new Date(l.updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{l.attempts > 1 ? ` · ${l.attempts} tries` : ""}</div>
                      {l.error && <div className="s" style={{ color: "var(--bad)" }}>{l.error}</div>}
                    </div>
                      {l.status === "synced" ? <Pill kind="good">In QuickBooks</Pill> : l.status === "needs_mapping" ? <Pill kind="warn">Map accounts</Pill> : <Pill kind="bad">Failed</Pill>}
                    </div>
                  ))}</div>
                ) : <Empty title={logView === "problems" ? "Nothing needs attention." : "Nothing sent yet."}>{logView === "problems" ? "Failed items are retried on every sync." : ""}</Empty>}
              </Card>
            </div>
          )}
        </div>
      )}
      {confirmOff && c && (
        <Modal title="Disconnect QuickBooks?" onClose={() => setConfirmOff(false)}
          footer={<><button type="button" className="btn" onClick={() => setConfirmOff(false)}>Cancel</button><button type="button" className="btn pri" disabled={!!busy} onClick={disconnect}>Disconnect</button></>}>
          <p>{hotel?.name} stops sending to {c.company_name || "QuickBooks"} and Akea's access is revoked. Everything already sent stays in QuickBooks, and the account mapping is kept in case you reconnect.</p>
        </Modal>
      )}
    </>
  );
}
