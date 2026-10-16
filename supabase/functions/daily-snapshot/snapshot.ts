// Builds the nightly "Daily snapshot" email for one hotel and business date, and sends it.
// Shared by the daily-snapshot function (preview / send now) and inbound-email (sent automatically after the night audit is read).

type Num = number | null | undefined;
const n = (v: Num) => (v == null || isNaN(Number(v)) ? null : Number(v));
const money = (v: Num, d = 2) => (n(v) == null ? "—" : (Number(v) < 0 ? "-$" : "$") + Math.abs(Number(v)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v: Num) => (n(v) == null ? "—" : `${(Number(v) * 100).toFixed(1)}%`);
const int = (v: Num) => (n(v) == null ? "—" : Math.round(Number(v)).toLocaleString("en-US"));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const addDays = (d: string, k: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

type K = { avail: number | null; sold: number | null; room: number | null; total: number | null };
const occ = (k: K) => (k.avail && k.sold != null ? k.sold / k.avail : null);
const adr = (k: K) => (k.sold && k.room != null ? k.room / k.sold : null);
const revpar = (k: K) => (k.avail && k.room != null ? k.room / k.avail : null);

const PAY: Record<string, string> = { ota: "OTA (online travel agencies)", amex: "Amex", direct_bill: "Direct bill", ach: "ACH" };
const payLabel = (s: string) => PAY[s] || s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function deltaCell(cur: number | null, prev: number | null, fmt: (v: number) => string, accent: string) {
  if (cur == null || prev == null) return `<td style="padding:8px 10px;text-align:right;color:#A9A293;font-size:13px;border-bottom:1px solid #EEE9DF">—</td>`;
  const d = cur - prev;
  const color = d > 0.00001 ? "#2D6A4F" : d < -0.00001 ? "#A63D2F" : "#5F5A51";
  return `<td style="padding:8px 10px;text-align:right;color:${color};font-size:13px;font-weight:600;white-space:nowrap;border-bottom:1px solid #EEE9DF">${d > 0 ? "▲" : d < 0 ? "▼" : ""} ${fmt(Math.abs(d))}</td>`;
  void accent;
}

export async function buildSnapshot(db: any, hotelId: string, date: string, portalUrl: string) {
  const { data: hotel } = await db.from("hotels").select("id,tenant_id,name,city,state,rooms,timezone").eq("id", hotelId).single();
  if (!hotel) throw new Error("Hotel not found");
  const { data: tenant } = await db.from("tenants").select("name,brand_name,product_name,logo_url,logo_light_url,accent_color,dark_color,email_sender").eq("id", hotel.tenant_id).single();
  // white-label names; only a plain #rrggbb colour goes into the email's styles
  const brand = (tenant?.brand_name || tenant?.name || "Hotel operations").replace(/[\r\n<>"]/g, " ").trim();
  const accent = /^#[0-9a-f]{6}$/i.test(tenant?.accent_color || "") ? tenant!.accent_color : "#9C7A43";
  const dark = /^#[0-9a-f]{6}$/i.test(tenant?.dark_color || "") ? tenant!.dark_color : "#14241F";   // header and button (Stone & Forest)
  const ly = addDays(date, -364);
  const monthStart = date.slice(0, 8) + "01", yearStart = date.slice(0, 5) + "01-01";
  const [{ data: dm }, { data: dmLy }, { data: stats }, { data: segs }, { data: deps }, { data: bud }, { data: hist }] = await Promise.all([
    db.from("daily_metrics").select("*").eq("hotel_id", hotelId).eq("business_date", date).maybeSingle(),
    db.from("daily_metrics").select("*").eq("hotel_id", hotelId).eq("business_date", ly).maybeSingle(),
    db.from("report_stats").select("*").eq("hotel_id", hotelId).eq("business_date", date),
    db.from("daily_segments").select("*").eq("hotel_id", hotelId).eq("business_date", date).order("rooms", { ascending: false }),
    db.from("expected_deposits").select("source,amount").eq("hotel_id", hotelId).eq("business_date", date).neq("status", "written_off"),
    db.from("budget_daily").select("business_date,rooms_sold,room_revenue,total_revenue").eq("hotel_id", hotelId).gte("business_date", yearStart).lte("business_date", date.slice(0, 5) + "12-31"),
    db.from("daily_metrics").select("business_date,rooms_available,rooms_sold,room_revenue,fnb_revenue,other_revenue").eq("hotel_id", hotelId).gte("business_date", addDays(yearStart, -364)).lte("business_date", date),
  ]);
  if (!dm) throw new Error(`No night audit numbers for ${hotel.name} on ${date} yet.`);
  const tot = (r: any) => (r ? Number(r.room_revenue || 0) + Number(r.fnb_revenue || 0) + Number(r.other_revenue || 0) : null);
  const day: K = { avail: n(dm.rooms_available), sold: n(dm.rooms_sold), room: n(dm.room_revenue), total: tot(dm) };
  const dayLy: K | null = dmLy ? { avail: n(dmLy.rooms_available), sold: n(dmLy.rooms_sold), room: n(dmLy.room_revenue), total: tot(dmLy) } : null;
  // period figures: as printed on the audit when available, otherwise summed from our own history
  const st = (p: string): K | null => {
    const r = (stats || []).find((x: any) => x.period === p);
    if (r) return { avail: n(r.rooms_available), sold: n(r.rooms_sold), room: n(r.room_revenue), total: n(r.total_revenue) };
    const [from, to] = p === "mtd" ? [monthStart, date] : p === "ytd" ? [yearStart, date] : p === "ly_mtd" ? [addDays(monthStart, -364), ly] : [addDays(yearStart, -364), ly];
    const rows = (hist || []).filter((h: any) => h.business_date >= from && h.business_date <= to);
    if (!rows.length) return null;
    return rows.reduce((a: K, h: any) => ({ avail: (a.avail || 0) + Number(h.rooms_available), sold: (a.sold || 0) + Number(h.rooms_sold), room: (a.room || 0) + Number(h.room_revenue), total: (a.total || 0) + tot(h)! }), { avail: 0, sold: 0, room: 0, total: 0 });
  };
  const mtd = st("mtd"), lyMtd = st("ly_mtd"), ytd = st("ytd"), lyYtd = st("ly_ytd");
  const budM = (bud || []).filter((b: any) => b.business_date >= monthStart && b.business_date <= (date.slice(0, 8) + "31"));
  const budMonthTotal = budM.reduce((a: number, b: any) => a + Number(b.total_revenue || 0), 0);
  const budMtd = budM.filter((b: any) => b.business_date <= date).reduce((a: number, b: any) => a + Number(b.total_revenue || 0), 0);
  const budYtd = (bud || []).filter((b: any) => b.business_date <= date).reduce((a: number, b: any) => a + Number(b.total_revenue || 0), 0);
  const left = Math.max(0, Number(dm.rooms_available || hotel.rooms) - Number(dm.rooms_sold || 0) - Number(dm.out_of_order || 0));

  const card = (label: string, value: string, sub = "") =>
    `<td width="25%" style="padding:6px"><div style="background:#FFFFFF;border:1px solid #E4DED3;border-radius:12px;padding:14px 12px;text-align:center">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5F5A51;font-weight:700">${label}</div>
      <div style="font-size:24px;font-weight:700;color:#14241F;margin-top:4px;font-family:Georgia,'Times New Roman',serif">${value}</div>
      ${sub ? `<div style="font-size:12px;color:#5F5A51;margin-top:2px">${sub}</div>` : ""}</div></td>`;
  const th = (t: string, right = true) => `<th style="padding:8px 10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5F5A51;text-align:${right ? "right" : "left"};border-bottom:1px solid #E4DED3">${t}</th>`;
  const td = (t: string, right = true, bold = false) => `<td style="padding:8px 10px;text-align:${right ? "right" : "left"};font-size:13.5px;color:#14241F;${bold ? "font-weight:700;" : ""}border-bottom:1px solid #EEE9DF;white-space:nowrap">${t}</td>`;
  const section = (title: string, body: string) =>
    `<tr><td style="padding:22px 24px 6px"><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${accent};font-weight:700">${esc(title)}</div></td></tr>
     <tr><td style="padding:0 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#FFFFFF;border:1px solid #E4DED3;border-radius:12px">${body}</table></td></tr>`;

  const dayRows: [string, number | null, number | null, (v: number) => string][] = [
    ["Occupancy", occ(day), dayLy ? occ(dayLy) : null, pct], ["ADR", adr(day), dayLy ? adr(dayLy) : null, (v) => money(v)],
    ["RevPAR", revpar(day), dayLy ? revpar(dayLy) : null, (v) => money(v)], ["Room revenue", day.room, dayLy?.room ?? null, (v) => money(v)],
    ["F&B revenue", n(dm.fnb_revenue), n(dmLy?.fnb_revenue), (v) => money(v)], ["Other revenue", n(dm.other_revenue), n(dmLy?.other_revenue), (v) => money(v)],
    ["Total revenue", day.total, dayLy?.total ?? null, (v) => money(v)], ["Taxes collected", n(dm.tax_total), n(dmLy?.tax_total), (v) => money(v)],
  ];
  const dayTable = `<tr>${th("", false)}${th("This year")}${th(`Last year · ${shortDay(ly)}`)}${th("Change")}</tr>` +
    dayRows.map(([l, a, b, f]) => `<tr>${td(esc(l), false, l === "Total revenue")}${td(a == null ? "—" : f(a), true, l === "Total revenue")}${td(b == null ? "—" : f(b))}${deltaCell(a, b, f, accent)}</tr>`).join("");
  const perRow = (l: string, a: K | null, b: K | null) => {
    const cells: [number | null, number | null, (v: number) => string][] = [[a?.sold ?? null, b?.sold ?? null, (v) => int(v)], [a ? occ(a) : null, b ? occ(b) : null, pct],
      [a ? adr(a) : null, b ? adr(b) : null, (v) => money(v)], [a ? revpar(a) : null, b ? revpar(b) : null, (v) => money(v)], [a?.total ?? null, b?.total ?? null, (v) => money(v, 0)]];
    return `<tr>${td(`<b>${l}</b>`, false)}${cells.map(([x, , f]) => td(x == null ? "—" : f(x))).join("")}</tr>
            <tr>${td(`<span style="color:#5F5A51">vs last year</span>`, false)}${cells.map(([x, y, f]) => deltaCell(x, y, f, accent)).join("")}</tr>`;
  };
  const periodTable = `<tr>${th("", false)}${th("Rooms sold")}${th("Occ")}${th("ADR")}${th("RevPAR")}${th("Revenue")}</tr>` + perRow("Month to date", mtd, lyMtd) + perRow("Year to date", ytd, lyYtd);
  const budgetTable = budMonthTotal ? `<tr>${th("", false)}${th("Actual")}${th("Budget")}${th("Variance")}</tr>
      <tr>${td("Month to date", false)}${td(money(mtd?.total, 0))}${td(money(budMtd, 0))}${deltaCell(mtd?.total ?? null, budMtd, (v) => money(v, 0), accent)}</tr>
      <tr>${td("Year to date", false)}${td(money(ytd?.total, 0))}${td(money(budYtd, 0))}${deltaCell(ytd?.total ?? null, budYtd, (v) => money(v, 0), accent)}</tr>
      <tr>${td(`Full ${new Date(date + "T12:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" })} budget`, false)}${td("")}${td(money(budMonthTotal, 0))}${td("")}</tr>` : "";
  const segRows = (segs || []).filter((s: any) => Number(s.rooms) || Number(s.revenue) || Number(s.revenue_mtd));
  const segTable = segRows.length ? `<tr>${th("Segment", false)}${th("Rooms")}${th("ADR")}${th("Revenue")}${th("MTD revenue")}${th("MTD vs LY")}</tr>` +
    segRows.map((s: any) => `<tr>${td(esc(s.segment), false)}${td(int(s.rooms))}${td(Number(s.rooms) ? money(Number(s.revenue) / Number(s.rooms)) : "—")}${td(money(s.revenue))}${td(money(s.revenue_mtd, 0))}${deltaCell(n(s.revenue_mtd), n(s.revenue_ly_mtd), (v) => money(v, 0), accent)}</tr>`).join("") : "";
  const depRows = (deps || []);
  const depTable = depRows.length ? `<tr>${th("Payment type", false)}${th("Today")}</tr>` + depRows.map((d: any) => `<tr>${td(esc(payLabel(String(d.source))), false)}${td(money(d.amount))}</tr>`).join("") +
    `<tr>${td("Total", false, true)}${td(money(depRows.reduce((a: number, d: any) => a + Number(d.amount), 0)), true, true)}</tr>` : "";

  const https = (u?: string | null) => (u && /^https:\/\//i.test(u) ? u : null);
  const headerLogo = https(tenant?.logo_light_url) || (!tenant?.logo_url && /^https:\/\//i.test(portalUrl) ? `${portalUrl}/logo-light.png` : null);
  const subject = `${hotel.name} ${hotel.city ? "· " + hotel.city : ""} — Daily snapshot for ${new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC" })}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F5F2EC;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14241F">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F5F2EC"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#FBF9F4;border-radius:16px;overflow:hidden;border:1px solid #E4DED3">
  <tr><td style="background:${dark};padding:28px 24px">
    <table role="presentation" width="100%"><tr>
      <td>${headerLogo ? `<img src="${esc(headerLogo)}" alt="${esc(brand)}" height="34" style="display:block;max-height:34px;border:0">` : `<div style="color:#EDE6D8;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:20px">${esc(brand)}</div>`}</td>
      <td align="right" style="color:#C9A66B;font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:600">Daily snapshot</td></tr></table>
    <div style="color:#EDE6D8;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:28px;margin-top:20px;line-height:1.2">${esc(hotel.name)}</div>
    <div style="color:#DCD3C1;font-size:14px;margin-top:4px">${esc([hotel.city, hotel.state].filter(Boolean).join(", "))} · Business date ${esc(longDate(date))}</div>
  </td></tr>
  <tr><td style="height:4px;background:${accent}"></td></tr>
  <tr><td style="padding:18px 18px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    ${card("Occupancy", pct(occ(day)), `${int(day.sold)} of ${int(day.avail)} rooms`)}${card("ADR", money(adr(day)))}${card("RevPAR", money(revpar(day)))}${card("Total revenue", money(day.total, 0))}
  </tr></table></td></tr>
  <tr><td style="padding:10px 24px 0;font-size:13px;color:#2E3F39">
    Rooms sold <b>${int(dm.rooms_sold)}</b> &nbsp;·&nbsp; Comp <b>${int(dm.comp_rooms)}</b> &nbsp;·&nbsp; Out of order <b>${int(dm.out_of_order)}</b> &nbsp;·&nbsp; No-shows <b>${int(dm.no_shows)}</b> &nbsp;·&nbsp; Left to sell <b>${int(left)}</b>
    &nbsp;·&nbsp; Arrivals <b>${int(dm.arrivals)}</b> &nbsp;·&nbsp; Departures <b>${int(dm.departures)}</b> &nbsp;·&nbsp; Guests in house <b>${int(dm.in_house_guests)}</b>
  </td></tr>
  ${section(`The day · ${shortDay(date)} vs same day last year`, dayTable)}
  ${section("Month & year to date", periodTable)}
  ${budgetTable ? section("Against budget", budgetTable) : ""}
  ${segTable ? section("Market segments", segTable) : ""}
  ${depTable ? section("Payments taken (expected in the bank)", depTable) : ""}
  <tr><td align="center" style="padding:26px 24px 8px"><a href="${esc(portalUrl)}/#hotel/${hotel.id}" style="display:inline-block;background:${dark};color:#EDE6D8;text-decoration:none;font-weight:600;font-size:14px;padding:13px 26px;border-radius:999px">Open the full dashboard</a></td></tr>
  <tr><td style="padding:10px 24px 24px;font-size:11.5px;color:#6E685D;text-align:center;line-height:1.6">
    Numbers come from the night audit report emailed by the hotel's PMS${(stats || []).length ? "; month and year figures are as printed on that report" : ""}.${!dayLy ? " Same-day last-year comparisons start once last year's audits are loaded." : ""}<br>
    Sent by ${esc(brand)} · You receive this because you're on this hotel's nightly report list.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, tenant_id: hotel.tenant_id, from: tenant?.email_sender || null, brand };
}

export async function sendEmail(opts: { from: string; fromName: string; to: string[]; subject: string; html: string }) {
  const pm = Deno.env.get("POSTMARK_SERVER_TOKEN"), rs = Deno.env.get("RESEND_API_KEY");
  if (!opts.to.length) return { sent: 0, note: "No recipients set up for this hotel." };
  if (pm) {
    const r = await fetch("https://api.postmarkapp.com/email/batch", { method: "POST", headers: { "X-Postmark-Server-Token": pm, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(opts.to.map((to) => ({ From: `${opts.fromName} <${opts.from}>`, To: to, Subject: opts.subject, HtmlBody: opts.html, MessageStream: "outbound" }))) });
    const j = await r.json().catch(() => []);
    const bad = Array.isArray(j) ? j.filter((x: any) => x.ErrorCode) : [j];
    if (!r.ok || bad.length) throw new Error((bad[0]?.Message) || `Postmark error ${r.status}`);
    return { sent: opts.to.length };
  }
  if (rs) {
    let sent = 0;
    for (const to of opts.to) {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${rs}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${opts.fromName} <${opts.from}>`, to, subject: opts.subject, html: opts.html }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Resend error ${r.status}`);
      sent++;
    }
    return { sent };
  }
  throw new Error("Email sending isn't set up yet. Add a Postmark (POSTMARK_SERVER_TOKEN) or Resend (RESEND_API_KEY) key in Supabase → Edge Functions → Secrets.");
}

export async function sendSnapshot(admin: any, hotelId: string, date: string, portalUrl: string, onlyTo?: string[]) {
  const snap = await buildSnapshot(admin, hotelId, date, portalUrl);
  let to = onlyTo;
  if (!to) {
    const { data: rec } = await admin.from("snapshot_recipients").select("email").eq("tenant_id", snap.tenant_id).or(`hotel_id.eq.${hotelId},hotel_id.is.null`);
    to = [...new Set((rec || []).map((r: any) => String(r.email).toLowerCase()))] as string[];
  }
  try {
    // sender address must be a plain email address (no header injection)
    const from = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i.test(snap.from || "") ? snap.from! : "reports@akeahms.com";
    const r = await sendEmail({ from, fromName: snap.brand, to, subject: snap.subject.replace(/[\r\n]+/g, " "), html: snap.html });
    await admin.from("snapshot_sends").insert({ tenant_id: snap.tenant_id, hotel_id: hotelId, business_date: date, recipients: r.sent, status: r.sent ? "sent" : "skipped", detail: r.note || to.join(", ") });
    return r;
  } catch (e) {
    await admin.from("snapshot_sends").insert({ tenant_id: snap.tenant_id, hotel_id: hotelId, business_date: date, recipients: 0, status: "failed", detail: (e as Error).message });
    throw e;
  }
}
