// Books review: the month-end checklist. Each line counts what's still open for the month and links to where it's fixed.
import React, { useState } from "react";
import { db } from "../lib/sb";
import { Ctx, usd, fmtDate, todayIn, addDays } from "../lib/app";
import { PageHead, Card, Pill, Loading, ErrorBox, useAsync, HotelSelect } from "../ui";

type Item = { key: string; group: string; title: string; detail: string; count: number; amount?: number; link: string; linkLabel: string; info?: boolean };

export function BooksReview({ ctx }: { ctx: Ctx }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const [hotel, setHotel] = useState("");
  const today = todayIn();
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const [month, setMonth] = useState(lastMonth);
  const from = `${month}-01`;
  const to = addDays(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
  const hq = hotel ? `&hotel_id=eq.${hotel}` : `&tenant_id=eq.${ctx.tenant.id}`;
  const q = useAsync(async (): Promise<Item[]> => {
    const [review, accts, books, lateDeps, uncleared, toPrint, overdue, noFile, noReceipt, days] = await Promise.all([
      db.getAll<any>(`bank_transactions?select=id,bank_account_id,gl_account_id,matched_kind,amount&status=in.(unmatched,matched)&posted_date=lte.${to}${hq}&order=id.asc`, 20000),
      db.get<any>(`bank_accounts?select=id,name,balance,balance_as_of,gl_account_id,hotel_id${hq}&order=name.asc`),
      db.rpc<any[]>("gl_balances", { p_from: "1900-01-01", p_to: to, p_hotels: hotel ? [hotel] : null }),
      db.getAll<any>(`expected_deposits?select=id,amount&status=eq.open&expected_date=lte.${addDays(today, -5)}&business_date=lte.${to}${hq}&order=id.asc`, 20000),
      db.getAll<any>(`checks?select=id,amount,check_date&status=eq.printed&check_date=lte.${addDays(to, -30)}${hq}&order=id.asc`, 20000),
      db.getAll<any>(`checks?select=id,amount&status=eq.to_print${hq}&order=id.asc`, 5000),
      db.getAll<any>(`bills?select=id,amount&status=in.(approved,scheduled)&due_date=lt.${today}${hq}&order=id.asc`, 20000),
      db.getAll<any>(`bills?select=id&status=in.(approved,scheduled,paid)&file_path=is.null&invoice_date=gte.${from}&invoice_date=lte.${to}${hq}&order=id.asc`, 20000),
      db.getAll<any>(`bank_transactions?select=id,amount&status=eq.posted&matched_kind=eq.gl&amount=lt.-75&attachment_path=is.null&posted_date=gte.${from}&posted_date=lte.${to}${hq}&order=id.asc`, 20000),
      db.getAll<any>(`daily_metrics?select=business_date,hotel_id,data_source&business_date=gte.${from}&business_date=lte.${to}${hotel ? `&hotel_id=eq.${hotel}` : ""}&order=business_date.asc,hotel_id.asc`, 20000),
    ]);
    const cleared = await db.getAll<any>(`bank_transactions?select=matched_ids&matched_kind=eq.check${hq}&order=id.asc`, 20000);
    const clearedIds = new Set(cleared.flatMap((x) => x.matched_ids || []));
    const unclearedOpen = uncleared.filter((c) => !clearedIds.has(c.id));
    const cleared30 = unclearedOpen.length;
    const off = accts.filter((a: any) => {
      if (a.balance == null) return false;
      const bk = books.filter((x) => x.account_id === a.gl_account_id).reduce((s, x) => s + Number(x.opening) + Number(x.debit) - Number(x.credit), 0);
      const pending = review.filter((t) => t.bank_account_id === a.id);
      return Math.abs(Number(a.balance) - bk) >= 0.01 && !pending.length;
    });
    const dr = books.reduce((s, x) => s + Number(x.opening) + Number(x.debit), 0), cr = books.reduce((s, x) => s + Number(x.credit), 0);
    const hotelsIn = hotel ? 1 : operating.length;
    const nDays = Number(to.slice(8, 10));
    const audited = days.filter((d) => d.data_source === "report").length;
    const sum = (xs: any[]) => xs.reduce((s, x) => s + Math.abs(Number(x.amount)), 0);
    return [
      { key: "review", group: "Transactions", title: "Bank transactions to review", detail: "Categorise and post everything from the bank up to month end.", count: review.length, amount: sum(review), link: "banking", linkLabel: "Review now" },
      { key: "uncat", group: "Transactions", title: "Bank lines without a category", detail: "These can't be posted until they have an account.", count: review.filter((t) => !t.gl_account_id && (!t.matched_kind || t.matched_kind === "gl")).length, link: "banking", linkLabel: "Categorise" },
      { key: "receipts", group: "Transactions", title: "Posted expenses over $75 without a receipt", detail: "Attach the receipt to the bank transaction.", count: noReceipt.length, amount: sum(noReceipt), link: "banking", linkLabel: "Attach receipts" },
      { key: "deps", group: "Accounts", title: "Night-audit deposits more than 5 days late", detail: "Card and cash deposits the night audit expected that haven't reached the bank.", count: lateDeps.length, amount: sum(lateDeps), link: "banking", linkLabel: "See deposits" },
      { key: "recon", group: "Accounts", title: "Bank accounts that don't agree with the books", detail: "Bank balance differs from the books with nothing left to review.", count: off.length, link: "fin-reports?r=recon", linkLabel: "Reconciliation summary" },
      { key: "checks", group: "Accounts", title: "Checks not cleared after 30 days", detail: "Follow up or void and reissue.", count: cleared30, amount: sum(unclearedOpen), link: "checks", linkLabel: "Check register" },
      { key: "print", group: "Accounts", title: "Checks waiting to print", detail: "Written but not printed yet.", count: toPrint.length, amount: sum(toPrint), link: "checks", linkLabel: "Print queue" },
      { key: "overdue", group: "Payables", title: "Approved bills past due", detail: "Pay or reschedule.", count: overdue.length, amount: sum(overdue), link: "bills", linkLabel: "Pay bills" },
      { key: "nofile", group: "Payables", title: "Bills this month without the invoice attached", detail: "Upload the vendor's invoice to the bill.", count: noFile.length, link: "bills", linkLabel: "Bills" },
      { key: "audits", group: "Revenue", title: "Nights without a night audit", detail: `${audited} of ${nDays * hotelsIn} hotel-nights have the night audit read.`, count: Math.max(0, nDays * hotelsIn - audited), link: "reports", linkLabel: "Report inbox", info: true },
      { key: "tb", group: "Wrap-up", title: "Trial balance in balance", detail: Math.abs(dr - cr) < 0.01 ? "Debits equal credits." : `Out by ${usd(Math.abs(dr - cr), 2)}.`, count: Math.abs(dr - cr) < 0.01 ? 0 : 1, link: "fin-reports?r=tb", linkLabel: "Trial balance" },
    ];
  }, [hotel, month]);
  const items = q.data || [];
  const done = items.filter((i) => !i.count).length;
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1)); return d.toISOString().slice(0, 7); });
  return (
    <>
      <PageHead eyebrow="Finance" title="Books Review" desc="Month-end close: everything still open for the month, and where to fix it." />
      <div className="toolbar">
        <HotelSelect hotels={operating} value={hotel} onChange={setHotel} all />
        <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m} value={m}>{new Date(m + "-15T12:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</option>)}</select>
        <span className="grow" />
        {q.data && <span className="small">{done} of {items.length} done</span>}
      </div>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : (
        <>
          <div className="prog" style={{ marginBottom: 18 }}><span style={{ width: `${(done / Math.max(1, items.length)) * 100}%`, background: "var(--good)" }} /></div>
          {[...new Set(items.map((i) => i.group))].map((g) => (
            <React.Fragment key={g}>
              <Card title={g} flush>
                <div className="list">{items.filter((i) => i.group === g).map((i) => (
                  <div key={i.key} className="li">
                    <span className="stripe" style={{ background: i.count ? (i.info ? "var(--info)" : "var(--warn)") : "var(--good)" }} />
                    <div style={{ minWidth: 0 }}><div className="t">{i.title}</div><div className="s">{i.detail}</div></div>
                    <div className="r acts">
                      {i.count ? <Pill kind={i.info ? "info" : "warn"}>{i.count}{i.amount ? ` · ${usd(i.amount, 2)}` : ""}</Pill> : <Pill kind="good">Done</Pill>}
                      {i.count > 0 && <a className="btn sm" href={"#" + i.link}>{i.linkLabel}</a>}
                    </div>
                  </div>
                ))}</div>
              </Card>
              <div className="sp" />
            </React.Fragment>
          ))}
          <p className="small muted">For {fmtDate(from)} – {fmtDate(to)}. Counts update as you work; nothing here changes the books by itself.</p>
        </>
      )}
    </>
  );
}
