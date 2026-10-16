import { PRODUCT_NAME } from "@/constants";
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { db } from "@/lib/sb";
import { useApp, useLoad, usd, pct, dayIn, timeIn, hoursBetween, midnightUtc, mondayOf } from "@/lib/app";
import { Screen, Card, Button, Stat, Row, Empty, ErrorText, Pill } from "@/components/ui";
import { brand, colors, space } from "@/theme";

type ClockStatus = { employee: string; clocked_in: boolean; clock_in: string | null; clock_out: string | null; minutes: number };

export default function Today() {
  const app = useApp();
  const tz = app.hotels.find((h) => h.id === app.employee?.hotel_id)?.timezone || "America/Chicago";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const clock = useLoad<ClockStatus | null>(() => (app.employee ? db.rpc<ClockStatus>("clock", { p_action: "status" }) : Promise.resolve(null)), [app.employee?.id]);
  const mine = useLoad(async () => {
    if (!app.employee) return { shift: null as any, week: 0 };
    const today = dayIn(tz);
    const weekStart = midnightUtc(mondayOf(today), tz);   // Monday 00:00 at the hotel, as a UTC instant
    const [shifts, punches] = await Promise.all([
      db.get<any>(`shifts?select=starts_at,ends_at,position,break_minutes&employee_id=eq.${app.employee.id}&published=eq.true&ends_at=gte.${new Date().toISOString()}&order=starts_at.asc&limit=1`),
      db.get<any>(`time_punches?select=clock_in,clock_out,break_minutes&employee_id=eq.${app.employee.id}&clock_in=gte.${weekStart}&order=clock_in.asc`),
    ]);
    const week = punches.reduce((a: number, p: any) => a + hoursBetween(p.clock_in, p.clock_out || new Date().toISOString(), p.break_minutes), 0);
    return { shift: shifts[0] || null, week };
  }, [app.employee?.id]);

  const showKpis = app.can("dashboards");
  const kpis = useLoad(async () => {
    if (!showKpis) return null;
    const y = dayIn(app.hotels[0]?.timezone || tz, -1);   // last night in the hotels' own time zone
    const rows = await db.get<any>(`daily_metrics?select=hotel_id,rooms_available,rooms_sold,room_revenue,fnb_revenue,other_revenue&business_date=eq.${y}`);
    return { date: y, rows };
  }, [showKpis]);

  async function punch(action: "in" | "out") {
    setBusy(true); setErr("");
    try {
      await db.rpc("clock", { p_action: action });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await Promise.all([clock.refresh(), mine.refresh()]);
    } catch (e: any) { setErr(e.message); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); }
    finally { setBusy(false); }
  }
  const refresh = () => { clock.refresh(); mine.refresh(); kpis.refresh(); app.reload(); };
  const c = clock.data;
  const onFor = c?.clocked_in && c.clock_in ? (now - Date.parse(c.clock_in)) / 3.6e6 : 0;

  const totals = (kpis.data?.rows || []).reduce((a: any, r: any) => ({ avail: a.avail + r.rooms_available, sold: a.sold + r.rooms_sold, room: a.room + Number(r.room_revenue),
    total: a.total + Number(r.room_revenue) + Number(r.fnb_revenue) + Number(r.other_revenue) }), { avail: 0, sold: 0, room: 0, total: 0 });

  return (
    <Screen refreshing={clock.loading && !!clock.data} onRefresh={refresh}>
      <Text style={styles.hello}>{greeting()}{app.employee ? `, ${app.employee.first_name}` : ""}</Text>

      {app.employee ? (
        <Card title="Time clock" right={c?.clocked_in ? <Pill text="On the clock" tone="good" /> : <Pill text="Off the clock" />}>
          {c?.clocked_in ? (
            <Text style={styles.big}>{fmtHours(onFor)}<Text style={styles.bigSub}>  since {timeIn(c.clock_in!, tz)}</Text></Text>
          ) : (
            <Text style={styles.muted}>{c?.clock_out ? `Last clocked out at ${timeIn(c.clock_out, tz)}` : "Not clocked in yet today."}</Text>
          )}
          {clock.error && !c ? (
            // status unknown: don't offer Clock in to someone who may already be on the clock
            <><ErrorText text={`Couldn't load your time clock. ${clock.error}`} /><Button title="Try again" kind="secondary" onPress={clock.refresh} /></>
          ) : clock.loading && !c ? null : c?.clocked_in
            ? <Button big kind="danger" title="Clock out" busy={busy} onPress={() => punch("out")} />
            : <Button big title="Clock in" busy={busy} onPress={() => punch("in")} />}
          {err ? <ErrorText text={err} /> : null}
          {mine.error ? <ErrorText text={`Couldn't load your hours: ${mine.error}`} /> : null}
          <View style={styles.statRow}>
            <Stat label="This week" value={mine.data ? fmtHours(mine.data.week) : "—"} sub={(mine.data?.week || 0) > 40 ? "Overtime" : `${Math.max(0, 40 - (mine.data?.week || 0)).toFixed(1)} h to 40`} />
            <Stat label="Next shift" value={mine.data?.shift ? timeIn(mine.data.shift.starts_at, tz) : "—"}
              sub={mine.data?.shift ? `${new Date(mine.data.shift.starts_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz })} · ${mine.data.shift.position || ""}` : "Nothing scheduled"} />
          </View>
        </Card>
      ) : (
        <Card title="Time clock"><Text style={styles.muted}>Your sign-in isn't linked to an employee profile, so the time clock is hidden. A manager can link you on the Team page in {PRODUCT_NAME}.</Text></Card>
      )}

      {showKpis && (
        <Card title={kpis.data ? `Last night · ${new Date(kpis.data.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Last night"}>
          {kpis.error ? <ErrorText text={kpis.error} /> : !kpis.data?.rows.length ? (
            <Empty title="No night audit yet" sub="Numbers appear here as soon as each hotel's report email is read." />
          ) : (
            <>
              <View style={styles.statRow}>
                <Stat label="Occupancy" value={pct(totals.sold / (totals.avail || 1))} sub={`${totals.sold} of ${totals.avail} rooms`} />
                <Stat label="ADR" value={usd(totals.room / (totals.sold || 1), 2)} />
              </View>
              <View style={styles.statRow}>
                <Stat label="RevPAR" value={usd(totals.room / (totals.avail || 1), 2)} />
                <Stat label="Total revenue" value={usd(totals.total)} />
              </View>
              {kpis.data.rows.map((r: any) => {
                const h = app.hotels.find((x) => x.id === r.hotel_id);
                return <Row key={r.hotel_id} title={h?.name || "Hotel"} subtitle={`${h?.city || ""} · Occ ${pct(r.rooms_sold / (r.rooms_available || 1))} · ADR ${usd(Number(r.room_revenue) / (r.rooms_sold || 1), 2)}`}
                  right={<Text style={styles.money}>{usd(Number(r.room_revenue) + Number(r.fnb_revenue) + Number(r.other_revenue))}</Text>} />;
              })}
            </>
          )}
        </Card>
      )}
    </Screen>
  );
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const fmtHours = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const styles = StyleSheet.create({
  hello: { fontSize: 22, fontWeight: "600", color: colors.label },
  big: { fontSize: 34, fontWeight: "700", color: colors.label, fontVariant: ["tabular-nums"] },
  bigSub: { fontSize: 15, fontWeight: "500", color: colors.secondaryLabel },
  muted: { fontSize: 15, color: colors.secondaryLabel, lineHeight: 21 },
  statRow: { flexDirection: "row", gap: space.md, flexWrap: "wrap" },
  money: { fontSize: 15, fontWeight: "700", color: colors.label, fontVariant: ["tabular-nums"] },
});
void brand;
