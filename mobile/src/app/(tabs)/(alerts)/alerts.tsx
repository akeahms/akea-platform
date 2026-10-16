import React, { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { db } from "@/lib/sb";
import { useApp, useLoad } from "@/lib/app";
import { Screen, Card, Row, Empty, ErrorText, Pill, Button, Loading } from "@/components/ui";
import { PORTAL_URL } from "@/constants";
import { brand, colors } from "@/theme";

export default function Alerts() {
  const app = useApp();
  const q = useLoad(async () => {
    const [list, reads] = await Promise.all([
      db.get<any>(`notifications?select=id,hotel_id,module,kind,title,body,link,due_on,created_at&tenant_id=eq.${app.tenantId}&order=due_on.asc.nullslast,created_at.desc&limit=80`),
      db.get<any>(`notification_reads?select=notification_id&user_id=eq.${app.userId}&limit=1000`),
    ]);
    const read = new Set(reads.map((r: any) => r.notification_id));
    return list.map((n: any) => ({ ...n, read: read.has(n.id) }));
  }, [app.tenantId]);
  const unread = (q.data || []).filter((n: any) => !n.read);
  const [err, setErr] = useState("");

  async function markAll() {
    if (!unread.length) return;
    try { await db.upsert("notification_reads", unread.map((n: any) => ({ notification_id: n.id })), "notification_id,user_id"); }
    catch (e: any) { setErr(e.message); }
    q.refresh();
  }
  function open(n: any) {
    if (!n.read) db.upsert("notification_reads", [{ notification_id: n.id }], "notification_id,user_id").then(() => q.refresh(), (e) => setErr(e.message));
    if (!n.link) return;
    // only open pages on this company's own site (a stored link could otherwise point anywhere)
    const target = /^https?:/i.test(n.link) ? n.link : PORTAL_URL + "/" + n.link.replace(/^\//, "");
    try { if (new URL(target).origin === new URL(PORTAL_URL).origin) Linking.openURL(target); } catch { /* malformed link: ignore */ }
  }
  const days = (d: string) => Math.round((Date.parse(d + "T12:00:00") - Date.now()) / 864e5);

  return (
    <Screen refreshing={q.loading && !!q.data} onRefresh={q.refresh}>
      {q.error || err ? <ErrorText text={q.error || err} /> : null}
      <Card title="Alerts" right={unread.length ? <Pill text={`${unread.length} new`} tone="bad" /> : undefined}>
        {q.loading && !q.data ? <Loading /> : q.error && !q.data ? null : !(q.data || []).length ? <Empty title="No alerts" sub="Permit, insurance and document renewals and overdue bills appear here." /> :
          q.data!.map((n: any) => {
            const d = n.due_on ? days(n.due_on) : null;
            const tone = d == null ? "info" : d < 0 ? "bad" : d <= 30 ? "warn" : "info";
            return (
              <View key={n.id} style={{ opacity: n.read ? 0.6 : 1 }}>
                <Row stripe={brand[tone as "bad"]} onPress={() => open(n)} title={n.title}
                  subtitle={[n.body, app.hotels.find((h) => h.id === n.hotel_id)?.name].filter(Boolean).join(" · ")}
                  right={d != null ? <Text style={[styles.due, { color: brand[tone as "bad"] }]}>{d < 0 ? `${-d}d late` : d === 0 ? "Today" : `${d}d`}</Text> : undefined} />
              </View>
            );
          })}
        {unread.length ? <Button kind="secondary" title="Mark all as read" onPress={markAll} /> : null}
      </Card>
    </Screen>
  );
}
const styles = StyleSheet.create({ due: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] } });
void colors;
