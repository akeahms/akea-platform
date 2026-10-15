import React, { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { db } from "@/lib/sb";
import { useApp, useLoad, usd, timeIn, dateLabel, hoursBetween } from "@/lib/app";
import { Screen, Card, Button, Row, Empty, ErrorText, Pill } from "@/components/ui";
import { colors, space } from "@/theme";

export default function Approvals() {
  const app = useApp();
  const bills = app.can("finance", "approve"), pos = app.can("purchasing", "approve"), punches = app.can("workforce", "approve");
  const [busy, setBusy] = useState<string>("");
  const q = useLoad(async () => {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const [b, p, t] = await Promise.all([
      bills ? db.get<any>(`bills?select=id,hotel_id,invoice_no,due_date,amount,description,vendors(name)&status=eq.pending_approval&order=due_date.asc.nullslast&limit=50`) : [],
      pos ? db.get<any>(`purchase_orders?select=id,hotel_id,po_no,needed_by,total,notes,vendors(name)&status=eq.submitted&order=created_at.asc&limit=50`) : [],
      punches ? db.get<any>(`time_punches?select=id,hotel_id,clock_in,clock_out,break_minutes,employees(first_name,last_name)&approved_at=is.null&clock_out=not.is.null&clock_in=gte.${since}&order=clock_in.asc&limit=200`) : [],
    ]);
    return { b, p, t };
  }, [bills, pos, punches]);
  const hotel = (id: string) => app.hotels.find((h) => h.id === id)?.name || "";

  function confirm(title: string, msg: string, run: () => Promise<unknown>, key: string, destructive = false) {
    Alert.alert(title, msg, [{ text: "Cancel", style: "cancel" }, {
      text: destructive ? "Reject" : "Approve", style: destructive ? "destructive" : "default",
      onPress: async () => {
        setBusy(key);
        try { await run(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); await q.refresh(); }
        catch (e: any) { Alert.alert("Couldn't save", e.message); }
        finally { setBusy(""); }
      },
    }]);
  }

  if (!bills && !pos && !punches) return <Screen><Card><Empty title="Nothing to approve" sub="Your role doesn't include approvals." /></Card></Screen>;
  const t = q.data?.t || [];
  const hrs = t.reduce((a: number, x: any) => a + hoursBetween(x.clock_in, x.clock_out, x.break_minutes), 0);
  const total = (q.data?.b.length || 0) + (q.data?.p.length || 0) + (t.length ? 1 : 0);

  return (
    <Screen refreshing={q.loading && !!q.data} onRefresh={q.refresh}>
      {q.error ? <ErrorText text={q.error} /> : null}
      {q.data && !total ? <Card><Empty title="You're all caught up" sub="Bills, purchase orders and timesheets waiting on you show up here." /></Card> : null}

      {bills && !!q.data?.b.length && (
        <Card title="Bills" right={<Pill text={String(q.data.b.length)} tone="warn" />}>
          {q.data.b.map((b: any) => (
            <View key={b.id} style={styles.item}>
              <Row title={b.vendors?.name || "Vendor"} subtitle={[hotel(b.hotel_id), b.invoice_no && `#${b.invoice_no}`, b.due_date && `due ${new Date(b.due_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, b.description].filter(Boolean).join(" · ")}
                right={<Text style={styles.money}>{usd(Number(b.amount), 2)}</Text>} />
              <View style={styles.actions}>
                <View style={{ flex: 1 }}><Button kind="secondary" title="Reject" busy={busy === "rb" + b.id} onPress={() => confirm("Reject bill?", `${b.vendors?.name || "Bill"} · ${usd(Number(b.amount), 2)}`, () => db.rpc("decide_bill", { p_id: b.id, p_approve: false, p_note: "Rejected on mobile" }), "rb" + b.id, true)} /></View>
                <View style={{ flex: 1 }}><Button title="Approve" busy={busy === "ab" + b.id} onPress={() => confirm("Approve bill?", `${b.vendors?.name || "Bill"} · ${usd(Number(b.amount), 2)}`, () => db.rpc("decide_bill", { p_id: b.id, p_approve: true, p_note: null }), "ab" + b.id)} /></View>
              </View>
            </View>
          ))}
        </Card>
      )}

      {pos && !!q.data?.p.length && (
        <Card title="Purchase orders" right={<Pill text={String(q.data.p.length)} tone="warn" />}>
          {q.data.p.map((p: any) => (
            <View key={p.id} style={styles.item}>
              <Row title={`${p.po_no} · ${p.vendors?.name || "Vendor"}`} subtitle={[hotel(p.hotel_id), p.needed_by && `needed ${new Date(p.needed_by + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, p.notes].filter(Boolean).join(" · ")}
                right={<Text style={styles.money}>{usd(Number(p.total), 2)}</Text>} />
              <View style={styles.actions}>
                <View style={{ flex: 1 }}><Button kind="secondary" title="Reject" busy={busy === "rp" + p.id} onPress={() => confirm("Reject purchase order?", `${p.po_no} · ${usd(Number(p.total), 2)}`, () => db.rpc("decide_po", { p_id: p.id, p_approve: false, p_note: "Rejected on mobile" }), "rp" + p.id, true)} /></View>
                <View style={{ flex: 1 }}><Button title="Approve" busy={busy === "ap" + p.id} onPress={() => confirm("Approve purchase order?", `${p.po_no} · ${usd(Number(p.total), 2)}`, () => db.rpc("decide_po", { p_id: p.id, p_approve: true, p_note: null }), "ap" + p.id)} /></View>
              </View>
            </View>
          ))}
        </Card>
      )}

      {punches && !!t.length && (
        <Card title="Timesheets · last 2 weeks" right={<Pill text={`${hrs.toFixed(1)} h`} tone="info" />}>
          {t.slice(0, 30).map((x: any) => {
            const tz = app.hotels.find((h) => h.id === x.hotel_id)?.timezone || "America/Chicago";
            return <Row key={x.id} title={x.employees ? `${x.employees.first_name} ${x.employees.last_name}` : "Employee"}
              subtitle={`${dateLabel(x.clock_in, tz)} · ${timeIn(x.clock_in, tz)} – ${timeIn(x.clock_out, tz)} · ${hotel(x.hotel_id)}`}
              right={<Text style={styles.money}>{hoursBetween(x.clock_in, x.clock_out, x.break_minutes).toFixed(2)} h</Text>} />;
          })}
          {t.length > 30 ? <Text style={styles.more}>+ {t.length - 30} more</Text> : null}
          <Button title={`Approve all ${t.length} punches`} busy={busy === "punches"}
            onPress={() => confirm("Approve timesheets?", `${t.length} completed punches, ${hrs.toFixed(1)} hours. Review edits on the portal first if anything looks off.`, () => db.rpc("approve_punches", { p_ids: t.map((x: any) => x.id) }), "punches")} />
        </Card>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  item: { gap: space.sm, paddingBottom: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  actions: { flexDirection: "row", gap: space.sm },
  money: { fontSize: 15, fontWeight: "700", color: colors.label, fontVariant: ["tabular-nums"] },
  more: { fontSize: 13, color: colors.secondaryLabel },
});
