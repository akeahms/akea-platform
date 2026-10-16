// Banking: review every bank transaction, categorise it (one at a time or in bulk), and POST it to the books.
// Posting, undo and exclude go through database functions that write balanced journal entries.
// Rules categorise new transactions automatically (and can post them). Statements, feeds and deposit matching are on Reconcile.
import React, { useMemo, useRef, useState } from "react";
import { db, storage } from "../lib/sb";
import { Ctx, usd, fmtDate, todayIn, addDays } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, Empty, useAsync, Modal, Field, HotelSelect, Notice, SampleBadge, Tabs, downloadFile, toCsv } from "../ui";
import { Gl, BankAcct, useLookups, glLabel, glPick, sanitize, openFile } from "../lib/books";
import { BankReconcile } from "./finance";

type Tx = {
  id: string; hotel_id: string; tenant_id: string; bank_account_id: string; posted_date: string; amount: number; description: string | null; ref: string | null;
  status: "unmatched" | "matched" | "posted" | "excluded"; matched_kind: string | null; matched_ids: string[] | null; variance: number | null; gl_account_id: string | null;
  txn_type: string | null; vendor_id: string | null; memo: string | null; rule_id: string | null; attachment_path: string | null; journal_entry_id: string | null;
  posted_at: string | null; data_source: string;
};
type Rule = {
  id: string; hotel_id: string; tenant_id: string; name: string; priority: number; bank_account_ids: string[] | null; direction: "in" | "out" | "any"; match_all: boolean;
  conditions: Cond[]; set_type: string | null; set_vendor_id: string | null; set_gl_account_id: string | null; set_memo: string | null; auto_post: boolean; active: boolean; applied_count: number;
};
type Cond = { field: "description" | "amount"; op: string; value: string; value2?: string };
type Result = { posted?: number; updated?: number; failed: { id: string; error: string }[] };

export const TX_TYPES: [string, string][] = [["expense", "Expense"], ["deposit", "Deposit"], ["check", "Check"], ["transfer", "Transfer"], ["refund", "Refund"], ["other", "Other"]];
const MATCH: Record<string, string> = { deposit: "Night-audit deposit", deposit_batch: "Card batch", deposit_amex: "Amex (net of fees)", bill: "Bill payment", check: "Check" };
const OPS: Record<string, [string, string][]> = {
  description: [["contains", "contains"], ["not_contains", "doesn't contain"], ["is", "is exactly"], ["starts", "starts with"]],
  amount: [["eq", "equals"], ["gt", "is more than"], ["lt", "is less than"], ["between", "is between"]],
};

export function Banking({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<"tx" | "rules" | "reconcile">("tx");
  return (
    <>
      <PageHead eyebrow="Finance" title="Banking" desc="Review what came through the bank, categorise it, and post it to the books. Rules do the repeat work; deposits match to the night audit." />
      <Tabs value={tab} onChange={setTab} tabs={[["tx", "Bank transactions"], ["rules", "Rules"], ["reconcile", "Statements & deposits"]]} />
      {tab === "tx" && <BankTransactions ctx={ctx} />}
      {tab === "rules" && <Rules ctx={ctx} />}
      {tab === "reconcile" && <BankReconcile ctx={ctx} embedded />}
    </>
  );
}

// ======================= bank transactions =======================
function BankTransactions({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("finance", "edit");
  const lk = useLookups(ctx);
  const accts = useAsync(async () => {
    const a = await db.get<BankAcct>(`bank_accounts?select=*&tenant_id=eq.${ctx.tenant.id}&order=name.asc`);
    const [review, books] = await Promise.all([
      db.getAll<{ bank_account_id: string }>(`bank_transactions?select=bank_account_id&tenant_id=eq.${ctx.tenant.id}&status=in.(unmatched,matched)&order=id.asc`),
      db.rpc<{ hotel_id: string; account_id: string; opening: number; debit: number; credit: number }[]>("gl_balances", { p_from: "1900-01-01", p_to: todayIn(), p_hotels: null }),
    ]);
    return { a, review, books };
  }, [ctx.tenant.id]);
  const [acctId, setAcctId] = useState("");
  const acct = accts.data?.a.find((a) => a.id === acctId) || accts.data?.a[0];
  const [view, setView] = useState<"review" | "posted" | "excluded">("review");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [dir, setDir] = useState<"all" | "in" | "out" | "uncat">("all");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ type: string; vendor: string; gl: string; memo: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const status = view === "review" ? "in.(unmatched,matched)" : view === "posted" ? "eq.posted" : "eq.excluded";
  const tx = useAsync(() => (acct ? db.getAll<Tx>(`bank_transactions?select=*&bank_account_id=eq.${acct.id}&status=${status}&order=posted_date.desc,id.asc`, 5000) : Promise.resolve([])), [acct?.id, view]);
  const vendors = lk.data?.vendors || [];
  const gl = glPick(lk.data?.gl, acct?.hotel_id);
  const glName = (id: string | null) => (id ? glLabel((lk.data?.gl || []).find((g) => g.id === id)) : "");
  const vName = (id: string | null) => vendors.find((v) => v.id === id)?.name || "";

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (tx.data || []).filter((t) =>
      (!needle || `${t.description || ""} ${t.ref || ""} ${t.memo || ""} ${vName(t.vendor_id)} ${Math.abs(t.amount).toFixed(2)}`.toLowerCase().includes(needle))
      && (!from || t.posted_date >= from) && (!to || t.posted_date <= to)
      && (dir === "all" || (dir === "in" ? t.amount > 0 : dir === "out" ? t.amount < 0 : !t.gl_account_id && !(t.matched_kind && t.matched_kind !== "gl"))));
  }, [tx.data, q, from, to, dir, vendors]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const selRows = (tx.data || []).filter((t) => sel.includes(t.id));
  const selTotal = selRows.reduce((a, t) => a + Number(t.amount), 0);
  const reviewOf = (id: string) => accts.data?.review.filter((r) => r.bank_account_id === id).length || 0;
  const booksOf = (a: BankAcct) => {
    const b = accts.data?.books.find((x) => x.account_id === a.gl_account_id);
    return b ? Number(b.opening) + Number(b.debit) - Number(b.credit) : 0;
  };
  function reload() { tx.reload(); accts.reload(); setSel([]); }
  function report(r: Result, verb: string) {
    const n = r.posted ?? r.updated ?? 0;
    const fails = r.failed || [];
    const first = fails.slice(0, 3).map((f) => { const t = (tx.data || []).find((x) => x.id === f.id); return `${t?.description || "Transaction"}: ${f.error}`; }).join(" · ");
    setMsg(fails.length ? { kind: n ? "info" : "bad", text: `${n} ${verb}. ${fails.length} need attention — ${first}${fails.length > 3 ? " …" : ""}` } : { kind: "good", text: `${n} ${verb}.` });
  }
  async function run(f: () => Promise<any>, after?: (r: any) => void) {
    setBusy(true); setMsg(null);
    try { const r = await f(); after?.(r); reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); }
    finally { setBusy(false); }
  }
  const post = (ids: string[]) => run(() => db.rpc<Result>("post_bank_transactions", { p_ids: ids }), (r) => report(r, ids.length === 1 && !r.failed.length ? "posted to the books" : "posted"));
  const exclude = (ids: string[], on = true) => run(() => db.rpc<number>("exclude_bank_transactions", { p_ids: ids, p_exclude: on }), (n) => setMsg({ kind: "good", text: `${n} ${on ? "excluded" : "restored to review"}.` }));
  const undo = (ids: string[]) => run(() => db.rpc<number>("undo_bank_transactions", { p_ids: ids }), (n) => setMsg({ kind: "good", text: `${n} back in review. The journal entries were reversed.` }));
  const setCat = (t: Tx, patch: { gl?: string; vendor?: string; type?: string }) =>
    run(() => db.rpc<Result>("categorize_bank_transactions", { p_ids: [t.id], p_type: patch.type || null, p_vendor: patch.vendor || null, p_gl: patch.gl || null, p_memo: null, p_post: false }),
      (r) => r.failed.length && report(r, "updated"));
  function exportCsv() {
    downloadFile(`bank-${acct?.name || "account"}-${view}-${todayIn()}.csv`, "﻿" + toCsv([["Date", "Description", "Ref", "Payee", "Category", "Memo", "Spent", "Received", "Status"],
      ...rows.map((t) => [t.posted_date, t.description, t.ref, vName(t.vendor_id), t.matched_kind && t.matched_kind !== "gl" ? MATCH[t.matched_kind] : glName(t.gl_account_id), t.memo,
        t.amount < 0 ? (-t.amount).toFixed(2) : "", t.amount > 0 ? Number(t.amount).toFixed(2) : "", t.status])]));
  }
  const allOnPage = shown.length > 0 && shown.every((t) => sel.includes(t.id));

  if (accts.loading && !accts.data) return <Loading />;
  if (accts.error) return <ErrorBox error={accts.error} retry={accts.reload} />;
  if (!accts.data?.a.length || !acct) return <Empty title="No bank accounts yet.">Add each hotel's operating account under Statements & deposits.</Empty>;
  return (
    <>
      <div className="acct-cards">
        {accts.data.a.map((a) => (
          <button key={a.id} type="button" className={"acct" + (a.id === acct.id ? " on" : "")} onClick={() => { setAcctId(a.id); setSel([]); setOpen(null); setPage(0); }}>
            <span className="tag">{ctx.hotels.find((h) => h.id === a.hotel_id)?.name} · {a.institution || "Bank"} ••{a.last4}</span>
            <b>{a.name}</b>
            <span className="small">Bank <b className="num">{a.balance != null ? usd(Number(a.balance), 2) : "—"}</b></span>
            <span className="small">In books <b className="num">{usd(booksOf(a), 2)}</b></span>
            <span className="tag">{reviewOf(a.id) ? <Pill kind="warn">{reviewOf(a.id)} to review</Pill> : <Pill kind="good">All reviewed</Pill>}</span>
          </button>
        ))}
      </div>
      <div className="sp" />
      <div className="tabs" role="tablist">
        {([["review", `For review (${reviewOf(acct.id)})`], ["posted", "Posted"], ["excluded", "Excluded"]] as const).map(([k, l]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => { setView(k); setSel([]); setOpen(null); setPage(0); }}>{l}</button>
        ))}
      </div>
      <div className="toolbar">
        <input type="search" aria-label="Search" placeholder="Search description, payee, amount…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} style={{ minWidth: 260 }} />
        <input type="date" aria-label="From" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
        <input type="date" aria-label="To" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
        <select aria-label="Show" value={dir} onChange={(e) => { setDir(e.target.value as any); setPage(0); }}>
          <option value="all">All transactions</option><option value="in">Money in</option><option value="out">Money out</option>
          {view === "review" && <option value="uncat">Needs a category</option>}
        </select>
        <span className="grow" />
        <span className="small muted">{rows.length} shown</span>
        <button className="btn sm" onClick={exportCsv} disabled={!rows.length}>Export</button>
        <button className="btn sm" onClick={() => window.print()}>Print</button>
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <Card flush>
        {tx.loading && !tx.data ? <Loading /> : tx.error ? <ErrorBox error={tx.error} retry={tx.reload} /> : !rows.length ? (
          <Empty title={view === "review" ? "Nothing to review." : view === "posted" ? "Nothing posted yet." : "Nothing excluded."}>{view === "review" ? "New bank lines appear here from feeds and statements." : undefined}</Empty>
        ) : (
          <div className="tw"><table className="btx">
            <thead><tr>
              {canEdit && <th style={{ width: 34 }}><input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={(e) => setSel(e.target.checked ? [...new Set([...sel, ...shown.map((t) => t.id)])] : sel.filter((id) => !shown.some((t) => t.id === id)))} /></th>}
              <th>Date</th><th>Bank description</th><th>Payee</th><th>Category or match</th><th className="n">Spent</th><th className="n">Received</th><th className="n">Action</th>
            </tr></thead>
            <tbody>{shown.map((t) => {
              const matched = !!t.matched_kind && t.matched_kind !== "gl";
              const inReview = t.status === "unmatched" || t.status === "matched";
              return (
                <React.Fragment key={t.id}>
                  <tr className={(sel.includes(t.id) ? "sel " : "") + (open === t.id ? "open" : "")} onClick={(e) => { if ((e.target as HTMLElement).closest("input,select,button,a")) return; setOpen(open === t.id ? null : t.id); }}>
                    {canEdit && <td><input type="checkbox" aria-label={`Select ${t.description || "transaction"}`} checked={sel.includes(t.id)} onChange={(e) => setSel(e.target.checked ? [...sel, t.id] : sel.filter((x) => x !== t.id))} /></td>}
                    <td className="nowrap small">{fmtDate(t.posted_date)}</td>
                    <td><span className="small">{t.description}</span>{t.ref && <span className="chip" style={{ marginLeft: 6 }}>#{t.ref}</span>}
                      {t.rule_id && <span className="chip" style={{ marginLeft: 6 }} title="Categorised by a rule">Rule</span>}{t.attachment_path && <span className="chip" style={{ marginLeft: 6 }}>Receipt</span>} <SampleBadge show={t.data_source === "sample"} /></td>
                    <td className="small" style={{ minWidth: 150 }}>
                      {inReview && canEdit && !matched ? (
                        <select aria-label="Payee" className="sm" value={t.vendor_id || ""} disabled={busy} onChange={(e) => e.target.value && setCat(t, { vendor: e.target.value })}>
                          <option value="">Select payee</option>{vendors.filter((v) => v.status === "active" || v.id === t.vendor_id).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      ) : vName(t.vendor_id)}
                    </td>
                    <td className="small" style={{ minWidth: 220 }}>
                      {matched ? <><Pill kind="good">{MATCH[t.matched_kind!] || "Matched"}</Pill>{Number(t.variance) ? <div className="tag">Difference {usd(Number(t.variance), 2)}</div> : null}</>
                        : inReview && canEdit ? (
                          <select aria-label="Category" className={"sm" + (t.gl_account_id ? "" : " need")} value={t.gl_account_id || ""} disabled={busy} onChange={(e) => e.target.value && setCat(t, { gl: e.target.value })}>
                            <option value="">{t.amount < 0 ? "Uncategorized expense" : "Uncategorized income"}</option>{gl.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}
                          </select>
                        ) : glName(t.gl_account_id) || <span className="muted">—</span>}
                    </td>
                    <td className="n">{t.amount < 0 ? usd(-Number(t.amount), 2) : ""}</td>
                    <td className="n up">{t.amount > 0 ? usd(Number(t.amount), 2) : ""}</td>
                    <td className="n nowrap">{canEdit && (inReview
                      ? <button className="btn sm pri" disabled={busy || (!matched && !t.gl_account_id)} title={!matched && !t.gl_account_id ? "Choose a category first" : "Post to the books"} onClick={() => post([t.id])}>{matched ? "Match" : "Post"}</button>
                      : t.status === "posted" ? <button className="btn sm" disabled={busy} onClick={() => undo([t.id])}>Undo</button>
                      : <button className="btn sm" disabled={busy} onClick={() => exclude([t.id], false)}>Restore</button>)}</td>
                  </tr>
                  {open === t.id && <tr className="detail"><td colSpan={canEdit ? 8 : 7}><TxDetail ctx={ctx} t={t} gl={gl} vendors={vendors} canEdit={canEdit && inReview} onDone={(text) => { setMsg({ kind: "good", text }); reload(); }} onError={(text) => setMsg({ kind: "bad", text })} /></td></tr>}
                </React.Fragment>
              );
            })}</tbody>
          </table></div>
        )}
        {rows.length > PAGE && (
          <div className="toolbar" style={{ padding: "10px 16px", margin: 0 }}>
            <span className="small muted">{page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length}</span><span className="grow" />
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="btn sm" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </Card>
      {sel.length > 0 && canEdit && (
        <div className="bulkbar" role="region" aria-label="Selected transactions">
          <span><b>{sel.length}</b> selected · {selTotal < 0 ? `${usd(-selTotal, 2)} out` : `${usd(selTotal, 2)} in`}</span>
          {view === "review" && <>
            <button className="btn sm pri" disabled={busy} onClick={() => post(sel)}>Post</button>
            <button className="btn sm" disabled={busy} onClick={() => setEdit({ type: "", vendor: "", gl: "", memo: "" })}>Edit</button>
            <button className="btn sm" disabled={busy} onClick={() => exclude(sel, true)}>Exclude</button>
          </>}
          {view === "posted" && <button className="btn sm" disabled={busy} onClick={() => undo(sel)}>Undo</button>}
          {view === "excluded" && <button className="btn sm" disabled={busy} onClick={() => exclude(sel, false)}>Restore</button>}
          <span className="grow" /><button className="link" onClick={() => setSel([])}>Clear</button>
        </div>
      )}
      {edit && (
        <Modal title={`Edit ${sel.length} selected transaction${sel.length === 1 ? "" : "s"}`} onClose={() => setEdit(null)}
          footer={<>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="btn" disabled={busy || (!edit.type && !edit.vendor && !edit.gl && !edit.memo)}
              onClick={() => run(() => db.rpc<Result>("categorize_bank_transactions", { p_ids: sel, p_type: edit.type || null, p_vendor: edit.vendor || null, p_gl: edit.gl || null, p_memo: edit.memo || null, p_post: false }), (r) => { report(r, "updated"); setEdit(null); })}>Apply</button>
            <button type="button" className="btn pri" disabled={busy || (!edit.gl && !selRows.every((t) => t.gl_account_id || (t.matched_kind && t.matched_kind !== "gl")))}
              onClick={() => run(() => db.rpc<Result>("categorize_bank_transactions", { p_ids: sel, p_type: edit.type || null, p_vendor: edit.vendor || null, p_gl: edit.gl || null, p_memo: edit.memo || null, p_post: true }), (r) => { report(r, "posted"); setEdit(null); })}>Apply and post</button>
          </>}>
          <p className="small muted" style={{ marginTop: 0 }}>Only the fields you fill in change. Matched deposits and payments keep their match.</p>
          <div className="fgrid">
            <Field label="Transaction type" id="beT"><select id="beT" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}><option value="">Keep as is</option>{TX_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Payee" id="beV"><select id="beV" value={edit.vendor} onChange={(e) => setEdit({ ...edit, vendor: e.target.value })}><option value="">Keep as is</option>{vendors.filter((v) => v.status === "active").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field label="Category (account)" id="beG"><select id="beG" value={edit.gl} onChange={(e) => setEdit({ ...edit, gl: e.target.value })}><option value="">Keep as is</option>{gl.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select></Field>
            <Field label="Memo" id="beM"><input id="beM" maxLength={200} value={edit.memo} onChange={(e) => setEdit({ ...edit, memo: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// one transaction, expanded: type, payee, category, memo, receipt, suggestions, deposit matches
function TxDetail({ ctx, t, gl, vendors, canEdit, onDone, onError }: { ctx: Ctx; t: Tx; gl: Gl[]; vendors: { id: string; name: string; status: string; default_gl: string | null }[];
  canEdit: boolean; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ type: t.txn_type || (t.amount < 0 ? "expense" : "deposit"), vendor: t.vendor_id || "", gl: t.gl_account_id || "", memo: t.memo || "" });
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const word = (t.description || "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w)).slice(0, 2).join(" ");
  const hist = useAsync(async () => {
    if (!word) return [];
    const r = await db.get<{ gl_account_id: string | null; vendor_id: string | null }>(`bank_transactions?select=gl_account_id,vendor_id&hotel_id=eq.${t.hotel_id}&status=eq.posted&description=ilike.*${encodeURIComponent(word)}*&order=posted_date.desc&limit=60`);
    const m = new Map<string, { gl: string | null; vendor: string | null; n: number }>();
    r.forEach((x) => { const k = `${x.gl_account_id}|${x.vendor_id}`; const e = m.get(k) || { gl: x.gl_account_id, vendor: x.vendor_id, n: 0 }; e.n++; m.set(k, e); });
    return [...m.values()].filter((x) => x.gl).sort((a, b) => b.n - a.n).slice(0, 3);
  }, [t.id]);
  const rule = useAsync(() => (t.rule_id ? db.get<{ name: string }>(`bank_rules?select=name&id=eq.${t.rule_id}`) : Promise.resolve([])), [t.rule_id]);
  const near = useAsync(() => (t.amount > 0 && canEdit && !(t.matched_kind && t.matched_kind !== "gl")
    ? db.get<any>(`expected_deposits?select=id,source,amount,business_date,expected_date&hotel_id=eq.${t.hotel_id}&status=eq.open&expected_date=gte.${addDays(t.posted_date, -6)}&expected_date=lte.${addDays(t.posted_date, 6)}&order=expected_date.asc&limit=40`)
    : Promise.resolve([])), [t.id]);
  const [pick, setPick] = useState<string[]>([]);
  const glName = (id: string | null) => glLabel(gl.find((g) => g.id === id));
  async function save(postIt: boolean) {
    setBusy(true);
    try {
      if (f.memo !== (t.memo || "") && !f.gl) await db.update("bank_transactions", `id=eq.${t.id}`, { memo: f.memo || null }, "id");
      const r = await db.rpc<Result>("categorize_bank_transactions", { p_ids: [t.id], p_type: f.type || null, p_vendor: f.vendor || null, p_gl: f.gl || null, p_memo: f.memo || null, p_post: postIt });
      if (r.failed.length) throw new Error(r.failed[0].error);
      onDone(postIt ? "Posted to the books." : "Saved.");
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  }
  async function attach(file: File) {
    if (file.size > 15 * 1024 * 1024) { onError("Receipts can be up to 15 MB."); return; }
    setBusy(true);
    try {
      const path = `${ctx.tenant.id}/receipts/${t.hotel_id}/${t.id}-${Date.now()}-${sanitize(file.name)}`;
      await storage.upload("vault", path, file);
      await db.update("bank_transactions", `id=eq.${t.id}`, { attachment_path: path }, "id");
      onDone("Receipt attached.");
    } catch (e: any) { onError(e.message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function matchDeposits() {
    setBusy(true);
    try { await db.rpc("match_transaction", { p_tx: t.id, p_kind: "deposit", p_ids: pick, p_gl: null }); onDone("Matched. Post it to put the deposit in the books."); }
    catch (e: any) { onError(e.message); } finally { setBusy(false); }
  }
  const pickedSum = (near.data || []).filter((e: any) => pick.includes(e.id)).reduce((a: number, e: any) => a + Number(e.amount), 0);
  return (
    <div className="txd">
      <div className="txd-form">
        <div className="small muted">Full bank description</div>
        <div style={{ marginBottom: 10 }}>{t.description}{t.ref ? ` · ref ${t.ref}` : ""} · {fmtDate(t.posted_date)} · <b>{usd(Number(t.amount), 2)}</b></div>
        {canEdit && !(t.matched_kind && t.matched_kind !== "gl") ? (
          <>
            <div className="fgrid">
              <Field label="Transaction type" id={"tt" + t.id}><select id={"tt" + t.id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TX_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label={t.amount < 0 ? "Paid to" : "Received from"} id={"tv" + t.id}>
                <select id={"tv" + t.id} value={f.vendor} onChange={(e) => {
                  const v = vendors.find((x) => x.id === e.target.value);
                  const def = v?.default_gl ? gl.find((g) => g.id === v.default_gl || g.template_id === v.default_gl)?.id : "";
                  setF({ ...f, vendor: e.target.value, gl: f.gl || def || "" });
                }}><option value="">—</option>{vendors.filter((v) => v.status === "active" || v.id === f.vendor).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
              </Field>
              <Field label={f.type === "transfer" ? "Transfer to / from account" : "Category"} id={"tg" + t.id}>
                <select id={"tg" + t.id} value={f.gl} onChange={(e) => setF({ ...f, gl: e.target.value })}>
                  <option value="">Choose…</option>{gl.filter((g) => f.type !== "transfer" || g.qbo_type === "Bank" || g.qbo_type === "Credit Card").map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}
                </select>
              </Field>
              <Field label="Memo" id={"tm" + t.id}><input id={"tm" + t.id} maxLength={200} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
            </div>
            <div className="acts" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={() => save(false)}>Save</button>
              <button className="btn pri" disabled={busy || !f.gl} onClick={() => save(true)}>Post</button>
              <label className="btn" htmlFor={"tf" + t.id}>{t.attachment_path ? "Replace receipt" : "Attach receipt"}</label>
              <input id={"tf" + t.id} ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.heic,.webp" onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])} />
              {t.attachment_path && <button className="link" onClick={() => openFile(t.attachment_path!).catch((e) => onError(e.message))}>Open receipt</button>}
            </div>
          </>
        ) : (
          <div className="small">
            {t.memo && <div>Memo: {t.memo}</div>}
            {t.gl_account_id && <div>Category: {glName(t.gl_account_id)}</div>}
            {t.posted_at && <div className="muted">Posted {new Date(t.posted_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</div>}
            {t.attachment_path && <button className="link" onClick={() => openFile(t.attachment_path!).catch((e) => onError(e.message))}>Open receipt</button>}
          </div>
        )}
      </div>
      {canEdit && (
        <div className="txd-side">
          <div className="small muted" style={{ marginBottom: 6 }}>Suggestions</div>
          {rule.data?.[0] && <div className="sugg on">Rule “{rule.data[0].name}” set this category</div>}
          {(hist.data || []).map((h, i) => (
            <button key={i} type="button" className="sugg" onClick={() => setF({ ...f, gl: h.gl || f.gl, vendor: h.vendor || f.vendor })}>
              <b>{glName(h.gl)}</b>{h.vendor ? ` · ${vendors.find((v) => v.id === h.vendor)?.name || ""}` : ""}<span className="tag"> used {h.n}× for “{word}”</span>
            </button>
          ))}
          {!rule.data?.[0] && !(hist.data || []).length && <div className="small muted">No history for this description yet. Once you post one, similar ones get suggested — or add a rule.</div>}
          {(near.data || []).length > 0 && (
            <>
              <div className="small muted" style={{ margin: "12px 0 6px" }}>Match to night-audit deposits</div>
              {(near.data || []).map((e: any) => (
                <label key={e.id} className="check-row small" htmlFor={"nd" + e.id}>
                  <input id={"nd" + e.id} type="checkbox" checked={pick.includes(e.id)} onChange={(ev) => setPick(ev.target.checked ? [...pick, e.id] : pick.filter((x) => x !== e.id))} />
                  {e.source.replace("_", " ")} · {usd(Number(e.amount), 2)} · night of {fmtDate(e.business_date)}
                </label>
              ))}
              {pick.length > 0 && <div className="small" style={{ margin: "6px 0" }}>Selected {usd(pickedSum, 2)} · difference {usd(Number(t.amount) - pickedSum, 2)}</div>}
              <button className="btn sm" disabled={busy || !pick.length} onClick={matchDeposits}>Match selected</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ======================= rules =======================
function Rules({ ctx }: { ctx: Ctx }) {
  const canEdit = ctx.can("finance", "edit");
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotelId, setHotelId] = useState(operating[0]?.id || "");
  const lk = useLookups(ctx);
  const data = useAsync(async () => {
    const [rules, accts] = await Promise.all([
      db.get<Rule>(`bank_rules?select=*&hotel_id=eq.${hotelId}&order=priority.asc,created_at.asc`),
      db.get<BankAcct>(`bank_accounts?select=id,name,last4,hotel_id&hotel_id=eq.${hotelId}&order=name.asc`),
    ]);
    return { rules, accts };
  }, [hotelId]);
  const [form, setForm] = useState<Partial<Rule> | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const gl = glPick(lk.data?.gl, hotelId);
  const vendors = lk.data?.vendors || [];
  const rules = data.data?.rules || [];
  const acctName = (id: string) => data.data?.accts.find((a) => a.id === id);
  const condText = (c: Cond) => c.field === "description"
    ? `Description ${OPS.description.find((o) => o[0] === c.op)?.[1]} “${c.value}”`
    : `Amount ${OPS.amount.find((o) => o[0] === c.op)?.[1]} ${usd(Number(c.value), 2)}${c.op === "between" ? ` and ${usd(Number(c.value2), 2)}` : ""}`;
  async function act(f: () => Promise<unknown>, ok?: string) {
    setBusy(true); setMsg(null);
    try { await f(); if (ok) setMsg({ kind: "good", text: ok }); data.reload(); }
    catch (e: any) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function move(r: Rule, dir: -1 | 1) {
    const i = rules.findIndex((x) => x.id === r.id), j = i + dir;
    if (j < 0 || j >= rules.length) return;
    // renumber in order so priorities stay unique (10, 20, 30…)
    const order = [...rules]; [order[i], order[j]] = [order[j], order[i]];
    await act(async () => { for (let k = 0; k < order.length; k++) if (order[k].priority !== (k + 1) * 10) await db.update("bank_rules", `id=eq.${order[k].id}`, { priority: (k + 1) * 10 }, "id"); });
  }
  async function runNow() {
    await act(async () => {
      let n = 0;
      for (const a of data.data?.accts || []) n += await db.rpc<number>("apply_bank_rules", { p_account: a.id });
      setMsg({ kind: "good", text: n ? `Rules categorised ${n} transaction${n === 1 ? "" : "s"} waiting for review.` : "No waiting transactions matched a rule." });
    });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const row = {
      tenant_id: ctx.tenant.id, hotel_id: hotelId, name: (form.name || "").trim(), direction: form.direction || "any", match_all: form.match_all ?? true,
      bank_account_ids: form.bank_account_ids?.length ? form.bank_account_ids : null,
      conditions: (form.conditions || []).map((c) => ({ ...c, value: String(c.value || "").trim(), ...(c.op === "between" ? { value2: String(c.value2 || "").trim() } : {}) })),
      set_type: form.set_type || null, set_vendor_id: form.set_vendor_id || null, set_gl_account_id: form.set_gl_account_id || null, set_memo: form.set_memo?.trim() || null,
      auto_post: !!form.auto_post, active: form.active ?? true,
    };
    await act(async () => {
      if (form.id) await db.update("bank_rules", `id=eq.${form.id}`, row, "id");
      else await db.insert("bank_rules", { ...row, priority: (rules.length + 1) * 10 }, "id");
      setForm(null);
    }, form.id ? "Rule saved." : "Rule added. Use “Run rules now” to apply it to transactions already waiting.");
  }
  const setCond = (i: number, patch: Partial<Cond>) => setForm({ ...form!, conditions: (form!.conditions || []).map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotelId} onChange={setHotelId} />
        <span className="grow" />
        {canEdit && <button className="btn" disabled={busy || !rules.length} onClick={runNow}>Run rules now</button>}
        {canEdit && <button className="btn pri" onClick={() => setForm({ name: "", direction: "out", match_all: true, conditions: [{ field: "description", op: "contains", value: "" }], active: true, auto_post: false, bank_account_ids: [] })}>New rule</button>}
      </div>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <p className="small muted" style={{ marginTop: 0 }}>Rules run in order (top first) on new bank lines from feeds and statements. The first rule that fits sets the payee and category; with auto-post on, it also posts.</p>
      <Card flush>
        {data.loading && !data.data ? <Loading /> : data.error ? <ErrorBox error={data.error} retry={data.reload} /> : !rules.length ? <Empty title="No rules yet.">Add one for each regular payee — payroll, utilities, card processor fees.</Empty> : (
          <div className="tw"><table>
            <thead><tr><th>Priority</th><th>Rule</th><th>Applied to</th><th>Conditions</th><th>Sets</th><th>Auto-post</th><th>Status</th><th /></tr></thead>
            <tbody>{rules.map((r, i) => {
              const gone = (r.bank_account_ids || []).filter((id) => !acctName(id));
              return (
                <React.Fragment key={r.id}>
                  {gone.length > 0 && <tr><td colSpan={8} className="warnrow">This rule can't run on {gone.length === 1 ? "a bank account" : `${gone.length} bank accounts`} that no longer exist{gone.length === (r.bank_account_ids || []).length ? " — edit it to choose an account" : ""}.</td></tr>}
                  <tr className={r.active ? "" : "muted"}>
                    <td className="nowrap">{i + 1}{canEdit && <> <button className="btn sm" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(r, -1)}>↑</button> <button className="btn sm" aria-label="Move down" disabled={busy || i === rules.length - 1} onClick={() => move(r, 1)}>↓</button></>}</td>
                    <td><b>{r.name}</b><div className="tag">{r.direction === "in" ? "Money in" : r.direction === "out" ? "Money out" : "In or out"} · used {r.applied_count}×</div></td>
                    <td className="small">{(r.bank_account_ids || []).length ? (r.bank_account_ids || []).map((id) => acctName(id)?.name || "(removed)").join(", ") : "All this hotel's accounts"}</td>
                    <td className="small">{r.conditions.map(condText).join(r.match_all ? " and " : " or ")}</td>
                    <td className="small">{[r.set_type && TX_TYPES.find((x) => x[0] === r.set_type)?.[1], r.set_vendor_id && vendors.find((v) => v.id === r.set_vendor_id)?.name, r.set_gl_account_id && glLabel((lk.data?.gl || []).find((g) => g.id === r.set_gl_account_id))].filter(Boolean).join(" · ")}</td>
                    <td>{r.auto_post ? <Pill kind="info">Auto-post</Pill> : <span className="muted small">Review first</span>}</td>
                    <td>{canEdit ? <label className="check-row small" htmlFor={"ra" + r.id}><input id={"ra" + r.id} type="checkbox" checked={r.active} disabled={busy} onChange={(e) => act(() => db.update("bank_rules", `id=eq.${r.id}`, { active: e.target.checked }, "id"))} /> Active</label>
                      : <Pill kind={r.active ? "good" : "mute"}>{r.active ? "Active" : "Off"}</Pill>}</td>
                    <td className="nowrap">{canEdit && <><button className="btn sm" onClick={() => setForm({ ...r })}>Edit</button> <button className="btn sm danger" disabled={busy} onClick={() => act(() => db.remove("bank_rules", `id=eq.${r.id}`), "Rule deleted.")}>Delete</button></>}</td>
                  </tr>
                </React.Fragment>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      {form && (
        <Modal title={form.id ? "Edit rule" : "New rule"} wide onClose={() => setForm(null)} onSubmit={save}
          footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn pri" disabled={busy}>Save rule</button></>}>
          <div className="fgrid">
            <Field label="Rule name" id="rN"><input id="rN" required maxLength={80} value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. ADP payroll" /></Field>
            <Field label="Applies to" id="rD"><select id="rD" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as any })}><option value="out">Money out</option><option value="in">Money in</option><option value="any">Money in or out</option></select></Field>
          </div>
          <fieldset className="hotel-picks" style={{ marginTop: 12 }}>
            <legend>Bank accounts (none ticked = all of this hotel's accounts)</legend>
            {(data.data?.accts || []).map((a) => (
              <label key={a.id} className="check-row" htmlFor={"rb" + a.id}><input id={"rb" + a.id} type="checkbox" checked={(form.bank_account_ids || []).includes(a.id)}
                onChange={(e) => setForm({ ...form, bank_account_ids: e.target.checked ? [...(form.bank_account_ids || []), a.id] : (form.bank_account_ids || []).filter((x) => x !== a.id) })} /> {a.name} ••{a.last4}</label>
            ))}
          </fieldset>
          <div className="sp" />
          <div className="acts"><b className="small">When</b>
            <select aria-label="Match all or any" value={form.match_all ? "all" : "any"} onChange={(e) => setForm({ ...form, match_all: e.target.value === "all" })}><option value="all">all of these are true</option><option value="any">any of these is true</option></select>
          </div>
          {(form.conditions || []).map((c, i) => (
            <div key={i} className="acts" style={{ marginTop: 8 }}>
              <select aria-label="Field" value={c.field} onChange={(e) => setCond(i, { field: e.target.value as any, op: e.target.value === "amount" ? "eq" : "contains", value: "" })}><option value="description">Bank description</option><option value="amount">Amount</option></select>
              <select aria-label="Condition" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{OPS[c.field].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input aria-label="Value" required value={c.value} inputMode={c.field === "amount" ? "decimal" : undefined} onChange={(e) => setCond(i, { value: e.target.value })} style={{ minWidth: 200 }} placeholder={c.field === "amount" ? "0.00" : "text"} />
              {c.op === "between" && <input aria-label="And" required value={c.value2 || ""} inputMode="decimal" onChange={(e) => setCond(i, { value2: e.target.value })} placeholder="0.00" />}
              {(form.conditions || []).length > 1 && <button type="button" className="btn sm" aria-label="Remove condition" onClick={() => setForm({ ...form, conditions: (form.conditions || []).filter((_, k) => k !== i) })}>✕</button>}
            </div>
          ))}
          {(form.conditions || []).length < 10 && <button type="button" className="link" onClick={() => setForm({ ...form, conditions: [...(form.conditions || []), { field: "description", op: "contains", value: "" }] })}>+ Add a condition</button>}
          <div className="sp" />
          <div className="fgrid">
            <Field label="Set type" id="rT"><select id="rT" value={form.set_type || ""} onChange={(e) => setForm({ ...form, set_type: e.target.value || null })}><option value="">—</option>{TX_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Set payee" id="rV"><select id="rV" value={form.set_vendor_id || ""} onChange={(e) => setForm({ ...form, set_vendor_id: e.target.value || null })}><option value="">—</option>{vendors.filter((v) => v.status === "active").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field label="Set category" id="rG"><select id="rG" value={form.set_gl_account_id || ""} onChange={(e) => setForm({ ...form, set_gl_account_id: e.target.value || null })}><option value="">—</option>{gl.map((g) => <option key={g.id} value={g.id}>{glLabel(g)}</option>)}</select></Field>
            <Field label="Set memo" id="rM"><input id="rM" maxLength={200} value={form.set_memo || ""} onChange={(e) => setForm({ ...form, set_memo: e.target.value })} /></Field>
          </div>
          <div className="sp" />
          <label className="check-row" htmlFor="rP"><input id="rP" type="checkbox" checked={!!form.auto_post} onChange={(e) => setForm({ ...form, auto_post: e.target.checked })} /> Post automatically (skip review)</label>
          <label className="check-row" htmlFor="rA"><input id="rA" type="checkbox" checked={form.active ?? true} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        </Modal>
      )}
    </>
  );
}
