import React, { useState } from "react";
import { db } from "../lib/sb";
import {
  Ctx, Period, periodRange, lastYear, summary, kpi, usd, usdShort, pct, num, fmtDate, yesterday, addDays, REPORT_LABEL, Hotel,
} from "../lib/app";
import { PageHead, Card, Kpi, Delta, Seg, Pill, Loading, ErrorBox, Empty, LineChart, HBars, useAsync } from "../ui";

const SampleNote = ({ show }: { show: boolean }) =>
  show ? (
    <div className="banner info">
      <span>
        <b>Sample data.</b> These figures are generated examples until each hotel's Final Audit Reports are uploaded. Real reports replace them day by day.
      </span>
    </div>
  ) : null;

// ======================= Portfolio =======================
export function Portfolio({ ctx, go }: { ctx: Ctx; go: (r: string) => void }) {
  const [period, setPeriod] = useState<Period>("MTD");
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const ids = operating.map((h) => h.id);
  const range = periodRange(period);
  const q = useAsync(async () => {
    const [cur, ly, missing, rgi, series] = await Promise.all([
      summary(range, ids),
      summary(lastYear(range), ids),
      db.rpc<{ hotel_id: string; report_type: string }[]>("missing_reports", { p_date: yesterday() }),
      db.get<{ hotel_id: string; rgi: number; period_end: string }>(`str_periods?select=hotel_id,rgi,period_end&period_type=eq.month&order=period_end.desc&limit=200`),
      db.rpc<any[]>("daily_series", { p_from: addDays(yesterday(), -89), p_to: yesterday(), p_hotels: ids }),
    ]);
    return { cur, ly, missing, rgi, series };
  }, [period, ids.join(",")]);

  return (
    <>
      <PageHead
        eyebrow="Dashboards"
        title="Portfolio Overview"
        desc={`${operating.length} operating hotels · ${operating.reduce((a, h) => a + h.rooms, 0)} rooms · ${fmtDate(range[0])}${range[0] !== range[1] ? " – " + fmtDate(range[1]) : ""} vs same period last year`}
        actions={<Seg label="Period" value={period} options={["Day", "MTD", "YTD"] as const} onChange={setPeriod} />}
      />
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (() => {
        const { cur, ly, missing, rgi, series } = q.data;
        const k = kpi(cur.all), l = kpi(ly.all);
        const latestRgi = new Map<string, number>();
        rgi.forEach((r) => !latestRgi.has(r.hotel_id) && latestRgi.set(r.hotel_id, Number(r.rgi)));
        const missingBy = new Map<string, string[]>();
        missing.forEach((m) => missingBy.set(m.hotel_id, [...(missingBy.get(m.hotel_id) || []), m.report_type]));
        return (
          <>
            <SampleNote show={cur.all.sample_days > 0} />
            <div className="kpis">
              <Kpi label="Occupancy" value={pct(k.occ)} delta={<Delta cur={k.occ} prev={l.occ} fmt={(v) => pct(v)} label="vs last year" />} />
              <Kpi label="ADR" value={usd(k.adr, 2)} delta={<Delta cur={k.adr} prev={l.adr} fmt={(v) => usd(v, 2)} label="vs last year" />} />
              <Kpi label="RevPAR" value={usd(k.revpar, 2)} delta={<Delta cur={k.revpar} prev={l.revpar} fmt={(v) => usd(v, 2)} label="vs last year" />} />
              <Kpi label="Room revenue" value={usdShort(cur.all.room_revenue)} delta={<Delta cur={cur.all.room_revenue} prev={ly.all.room_revenue} fmt={usdShort} label="vs last year" />} />
              <Kpi label="Total revenue" value={usdShort(k.total)} delta={<Delta cur={k.total} prev={l.total} fmt={usdShort} label="vs last year" />} />
              <Kpi label="Rooms sold" value={num(cur.all.rooms_sold)} delta={<Delta cur={cur.all.rooms_sold} prev={ly.all.rooms_sold} fmt={(v) => num(v)} label="vs last year" />} />
            </div>
            <div className="grid g-2-1">
              <Card title="Hotels" note="Click a hotel to open it" flush>
                <div className="tw">
                  <table>
                    <thead>
                      <tr><th>Hotel</th><th className="n">Occ</th><th className="n">ADR</th><th className="n">RevPAR</th><th className="n">vs LY</th><th className="n">RGI</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {operating.map((h) => {
                        const t = cur.byHotel.get(h.id), tl = ly.byHotel.get(h.id);
                        if (!t) return null;
                        const a = kpi(t), b = tl ? kpi(tl) : null;
                        const miss = missingBy.get(h.id) || [];
                        return (
                          <tr key={h.id}>
                            <td>
                              <a href={`#hotel/${h.id}`} className="nowrap">{h.name}</a>
                              <div className="tag nowrap">{h.city}, {h.state} · {h.brand_family}</div>
                            </td>
                            <td className="n">{pct(a.occ)}</td>
                            <td className="n">{usd(a.adr, 2)}</td>
                            <td className="n">{usd(a.revpar, 2)}</td>
                            <td className="n">{b ? <Delta cur={a.revpar} prev={b.revpar} fmt={(v) => pct(v / b.revpar)} label="" /> : "—"}</td>
                            <td className="n">{latestRgi.has(h.id) ? latestRgi.get(h.id)!.toFixed(1) : "—"}</td>
                            <td>{miss.length ? <Pill kind="bad">{miss.length} missing reports</Pill> : <Pill kind="good">Reports in</Pill>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title="Needs attention" flush>
                <div className="list">
                  {[...missingBy.entries()].map(([hid, types]) => {
                    const h = ctx.hotels.find((x) => x.id === hid);
                    return (
                      <div className="li" key={hid}>
                        <span className="stripe" style={{ background: "var(--bad)" }} />
                        <div style={{ minWidth: 0 }}>
                          <div className="t">Missing reports · {h?.name}</div>
                          <div className="s">{fmtDate(yesterday())}: {types.map((t) => REPORT_LABEL[t] || t).join(", ")}</div>
                        </div>
                        <div className="r"><button className="btn sm" onClick={() => go("reports")}>Upload</button></div>
                      </div>
                    );
                  })}
                  {[...latestRgi.entries()].filter(([, v]) => v < 100).map(([hid, v]) => {
                    const h = ctx.hotels.find((x) => x.id === hid);
                    return (
                      <div className="li" key={"rgi" + hid}>
                        <span className="stripe" style={{ background: "var(--warn)" }} />
                        <div style={{ minWidth: 0 }}>
                          <div className="t">Below fair share · {h?.name}</div>
                          <div className="s">RevPAR index {v.toFixed(1)} last month</div>
                        </div>
                        <div className="r"><button className="btn sm" onClick={() => go(`str/${hid}`)}>Open</button></div>
                      </div>
                    );
                  })}
                  {!missingBy.size && ![...latestRgi.values()].some((v) => v < 100) && <Empty title="Nothing needs attention right now." />}
                </div>
              </Card>
            </div>
            <div className="sp" />
            <div className="grid g2">
              <Card title="Portfolio occupancy, last 90 days">
                <LineChart
                  labels={series.map((r) => r.business_date.slice(5).replace("-", "/"))}
                  series={[{ name: "Occupancy", values: series.map((r) => (Number(r.rooms_sold) / Number(r.rooms_available)) * 100), color: "var(--accent)" }]}
                  fmt={(v) => v.toFixed(0) + "%"}
                />
              </Card>
              <Card title="RevPAR by hotel" note={period === "Day" ? fmtDate(range[1]) : period}>
                <HBars rows={operating.filter((h) => cur.byHotel.get(h.id)).map((h) => ({ label: h.name, value: kpi(cur.byHotel.get(h.id)!).revpar }))} fmt={(v) => usd(v, 2)} />
              </Card>
            </div>
          </>
        );
      })()}
    </>
  );
}

// ======================= Hotel overview =======================
export function HotelOverview({ ctx, hotelId, go }: { ctx: Ctx; hotelId?: string; go: (r: string) => void }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const hotel = operating.find((h) => h.id === hotelId) || operating[0];
  const [period, setPeriod] = useState<Period>("Day");
  const [cmp, setCmp] = useState<"LY" | "Budget">("LY");
  const range = periodRange(period);
  const q = useAsync(async () => {
    if (!hotel) return null;
    const ids = [hotel.id];
    const [cur, ly, bud, missing, series, reports] = await Promise.all([
      summary(range, ids),
      summary(lastYear(range), ids),
      db.rpc<any[]>("budget_summary", { p_from: range[0], p_to: range[1], p_hotels: ids }),
      db.rpc<any[]>("missing_reports", { p_date: yesterday() }),
      db.rpc<any[]>("daily_series", { p_from: addDays(yesterday(), -59), p_to: yesterday(), p_hotels: ids }),
      db.get<any>(`reports?select=id,report_type,business_date,status,file_format,received_at,source&hotel_id=eq.${hotel.id}&business_date=eq.${yesterday()}&order=received_at.desc`),
    ]);
    return { cur: cur.all, ly: ly.all, bud: bud[0], missing: missing.filter((m) => m.hotel_id === hotel.id), series, reports };
  }, [hotel?.id, period]);

  if (!hotel) return <Empty title="No operating hotels yet." />;
  return (
    <>
      <PageHead
        eyebrow="Hotel Overview"
        title={hotel.name}
        desc={`${hotel.city}, ${hotel.state} · ${hotel.brand_family} · ${hotel.rooms} rooms${hotel.str_id ? " · STR " + hotel.str_id : ""} · business date ${fmtDate(yesterday())}`}
        actions={
          <>
            <label className="inline-select" htmlFor="hotelPick">
              <span className="sr">Hotel</span>
              <select id="hotelPick" value={hotel.id} onChange={(e) => go(`hotel/${e.target.value}`)}>
                {operating.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.city}</option>)}
              </select>
            </label>
            <Seg label="Period" value={period} options={["Day", "MTD", "YTD"] as const} onChange={setPeriod} />
            <Seg label="Compare with" value={cmp} options={[["LY", "Last year"], ["Budget", "Budget"]] as ["LY" | "Budget", string][]} onChange={setCmp} />
          </>
        }
      />
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (() => {
        const { cur, ly, bud, missing, series, reports } = q.data;
        const k = kpi(cur), l = kpi(ly);
        const budK = bud ? { rooms: Number(bud.rooms_sold), rev: Number(bud.room_revenue), total: Number(bud.total_revenue) } : null;
        const prev = (lyVal: number, budVal?: number) => (cmp === "LY" ? lyVal : budVal ?? 0);
        const lbl = cmp === "LY" ? "vs last year" : "vs budget";
        const budOcc = budK ? budK.rooms / cur.rooms_available : 0;
        const budAdr = budK && budK.rooms ? budK.rev / budK.rooms : 0;
        const budRevpar = budK ? budK.rev / cur.rooms_available : 0;
        return (
          <>
            {missing.length > 0 && (
              <div className="banner bad">
                <span><b>Missing reports for {fmtDate(yesterday())}:</b> {missing.map((m) => REPORT_LABEL[m.report_type]).join(", ")}. Guest folio checks run once they arrive.</span>
                <button className="btn sm" onClick={() => go("reports")}>Upload now</button>
              </div>
            )}
            <SampleNote show={cur.sample_days > 0} />
            <div className="kpis">
              <Kpi label="Rooms sold" value={num(cur.rooms_sold)} delta={<Delta cur={cur.rooms_sold} prev={prev(ly.rooms_sold, budK?.rooms)} fmt={(v) => num(v)} label={lbl} />} />
              <Kpi label="Occupancy" value={pct(k.occ)} delta={<Delta cur={k.occ} prev={prev(l.occ, budOcc)} fmt={(v) => pct(v)} label={lbl} />} />
              <Kpi label="ADR" value={usd(k.adr, 2)} delta={<Delta cur={k.adr} prev={prev(l.adr, budAdr)} fmt={(v) => usd(v, 2)} label={lbl} />} />
              <Kpi label="RevPAR" value={usd(k.revpar, 2)} delta={<Delta cur={k.revpar} prev={prev(l.revpar, budRevpar)} fmt={(v) => usd(v, 2)} label={lbl} />} />
              <Kpi label="Room revenue" value={usd(cur.room_revenue, 2)} delta={<Delta cur={cur.room_revenue} prev={prev(ly.room_revenue, budK?.rev)} fmt={(v) => usd(v)} label={lbl} />} />
              <Kpi label="Total revenue" value={usd(k.total, 2)} delta={<Delta cur={k.total} prev={prev(l.total, budK?.total)} fmt={(v) => usd(v)} label={lbl} />} />
              <Kpi label="F&B revenue" value={usd(cur.fnb_revenue, 2)} />
              <Kpi label="Other revenue" value={usd(cur.other_revenue, 2)} />
              <Kpi label="No-shows" value={num(cur.no_shows)} />
              <Kpi label="Out of order" value={num(cur.out_of_order)} />
              <Kpi label="Comp rooms" value={num(cur.comp_rooms)} />
              <Kpi label="Arrivals" value={num(cur.arrivals)} />
              <Kpi label="Departures" value={num(cur.departures)} />
              <Kpi label="In-house guests" value={num(cur.in_house_guests)} />
            </div>
            <div className="grid g2">
              <Card title="Occupancy, last 60 days">
                <LineChart labels={series.map((r) => r.business_date.slice(5).replace("-", "/"))}
                  series={[{ name: "Occupancy", values: series.map((r) => (Number(r.rooms_sold) / Number(r.rooms_available)) * 100), color: "var(--accent)" }]}
                  fmt={(v) => v.toFixed(0) + "%"} min={0} max={100} />
              </Card>
              <Card title="ADR, last 60 days" note="Separate chart, separate scale">
                <LineChart labels={series.map((r) => r.business_date.slice(5).replace("-", "/"))}
                  series={[{ name: "ADR", values: series.map((r) => Number(r.room_revenue) / Math.max(1, Number(r.rooms_sold))), color: "var(--accent)" }]}
                  fmt={(v) => "$" + v.toFixed(0)} />
              </Card>
            </div>
            <div className="sp" />
            <div className="grid g2">
              <Card title={`Reports for ${fmtDate(yesterday())}`} flush>
                {reports.length ? (
                  <div className="tw"><table>
                    <thead><tr><th>Report</th><th>Format</th><th>Received</th><th>Status</th></tr></thead>
                    <tbody>{reports.map((r: any) => (
                      <tr key={r.id}><td>{REPORT_LABEL[r.report_type] || r.report_type}</td><td><span className="chip">{r.file_format || "—"}</span></td>
                        <td>{new Date(r.received_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</td>
                        <td><Pill kind={r.status === "processed" ? "good" : r.status === "needs_review" ? "warn" : r.status === "failed" ? "bad" : "info"}>{r.status.replace("_", " ")}</Pill></td></tr>
                    ))}</tbody></table></div>
                ) : <Empty title="No reports received for this date yet." />}
              </Card>
              <Card title="Next 30 days · on the books">
                <Empty title="Waiting for the Occupancy Forecast report">
                  Upload this hotel's Occupancy Forecast and the 30-day chart of rooms on the books, forecast and pickup appears here.
                </Empty>
              </Card>
            </div>
          </>
        );
      })()}
    </>
  );
}

// ======================= STR =======================
export function Str({ ctx, hotelId, go }: { ctx: Ctx; hotelId?: string; go: (r: string) => void }) {
  const operating = ctx.hotels.filter((h) => h.status === "operating");
  const hotel = operating.find((h) => h.id === hotelId) || operating[0];
  const q = useAsync(async () =>
    hotel ? db.get<any>(`str_periods?select=*&hotel_id=eq.${hotel.id}&period_type=eq.month&order=period_end.asc`) : [], [hotel?.id]);
  if (!hotel) return <Empty title="No operating hotels yet." />;
  const ix = (v: number) => <b className={v >= 100 ? "up" : "dn"}>{Number(v).toFixed(1)}</b>;
  return (
    <>
      <PageHead eyebrow="Dashboards · STR" title={`STR Market · ${hotel.name}`}
        desc="Your hotel against its competitive set. An index above 100 means more than your fair share."
        actions={
          <select aria-label="Hotel" value={hotel.id} onChange={(e) => go(`str/${e.target.value}`)}>
            {operating.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.city}</option>)}
          </select>
        } />
      {q.loading && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={q.reload} />}
      {q.data && (q.data.length ? (
        <>
          <div className="banner info"><span><b>Sample data.</b> Upload this hotel's STAR reports (Excel) in Report Inbox to replace these figures.</span></div>
          <Card title="RevPAR index (RGI), last 13 months" note="Dashed line = 100, fair share">
            <LineChart labels={q.data.map((r: any) => fmtDate(r.period_end).slice(0, 3) + " " + r.period_end.slice(2, 4))}
              series={[{ name: "RGI", values: q.data.map((r: any) => Number(r.rgi)), color: "var(--accent)" }]} refLine={100} fmt={(v) => v.toFixed(0)} />
          </Card>
          <div className="sp" />
          <Card title="Monthly index scorecard" flush>
            <div className="tw"><table>
              <thead><tr><th>Month</th><th className="n">Occ</th><th className="n">Comp</th><th className="n">MPI</th><th className="n">ADR</th><th className="n">Comp</th><th className="n">ARI</th><th className="n">RevPAR</th><th className="n">Comp</th><th className="n">RGI</th><th>Rank</th></tr></thead>
              <tbody>{[...q.data].reverse().map((r: any) => (
                <tr key={r.period_end}><td>{fmtDate(r.period_end).replace(/ \d+,/, "")}</td>
                  <td className="n">{pct(r.occ)}</td><td className="n">{pct(r.occ_comp)}</td><td className="n">{ix(r.mpi)}</td>
                  <td className="n">{usd(r.adr, 2)}</td><td className="n">{usd(r.adr_comp, 2)}</td><td className="n">{ix(r.ari)}</td>
                  <td className="n">{usd(r.revpar, 2)}</td><td className="n">{usd(r.revpar_comp, 2)}</td><td className="n">{ix(r.rgi)}</td><td>{r.rank_rgi}</td></tr>
              ))}</tbody></table></div>
          </Card>
        </>
      ) : <Empty title="No STR data yet">Upload a STAR report in Report Inbox.</Empty>)}
    </>
  );
}

export type { Hotel };
