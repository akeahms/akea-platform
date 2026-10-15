import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { db } from "@/lib/sb";
import { useApp, useLoad, timeIn, hoursBetween } from "@/lib/app";
import { Screen, Card, Row, Empty, ErrorText, Pill } from "@/components/ui";
import { colors } from "@/theme";

export default function Schedule() {
  const app = useApp();
  const tz = app.hotels.find((h) => h.id === app.employee?.hotel_id)?.timezone || "America/Chicago";
  const isManager = app.can("workforce", "edit");
  const q = useLoad(async () => {
    const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 14 * 864e5).toISOString();
    const mine = app.employee ? await db.get<any>(`shifts?select=id,starts_at,ends_at,position,break_minutes,published,departments(name,color)&employee_id=eq.${app.employee.id}&published=eq.true&starts_at=gte.${from}&starts_at=lt.${to}&order=starts_at.asc`) : [];
    let team: any[] = [];
    if (isManager) {
      const start = new Date(); start.setHours(0, 0, 0, 0); const end = new Date(start.getTime() + 864e5);
      team = await db.get<any>(`shifts?select=id,hotel_id,starts_at,ends_at,position,employees(first_name,last_name),departments(name,color)&starts_at=gte.${start.toISOString()}&starts_at=lt.${end.toISOString()}&order=starts_at.asc&limit=200`);
    }
    return { mine, team };
  }, [app.employee?.id, isManager]);
  const byDay = new Map<string, any[]>();
  (q.data?.mine || []).forEach((s: any) => {
    const k = new Date(s.starts_at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: tz });
    byDay.set(k, [...(byDay.get(k) || []), s]);
  });
  const total = (q.data?.mine || []).reduce((a: number, s: any) => a + hoursBetween(s.starts_at, s.ends_at, s.break_minutes), 0);
  return (
    <Screen refreshing={q.loading && !!q.data} onRefresh={q.refresh}>
      {q.error ? <ErrorText text={q.error} /> : null}
      <Card title="My shifts · next 2 weeks" right={<Pill text={`${total.toFixed(1)} h`} tone="info" />}>
        {!app.employee ? <Empty title="Not linked to an employee profile" sub="Ask your manager to link your sign-in on the portal's Team page." />
          : !byDay.size ? <Empty title="No published shifts yet" sub="Your manager publishes the schedule each week." />
          : [...byDay.entries()].map(([day, shifts]) => (
            <View key={day} style={{ gap: 2 }}>
              <Text style={styles.day}>{day}</Text>
              {shifts.map((s) => <Row key={s.id} stripe={s.departments?.color || "#9A7432"} title={`${timeIn(s.starts_at, tz)} – ${timeIn(s.ends_at, tz)}`}
                subtitle={[s.position, s.departments?.name, s.break_minutes ? `${s.break_minutes} min break` : ""].filter(Boolean).join(" · ")} />)}
            </View>
          ))}
      </Card>
      {isManager && (
        <Card title="Working today">
          {!(q.data?.team || []).length ? <Empty title="Nobody scheduled today" /> : (q.data!.team).map((s: any) => (
            <Row key={s.id} stripe={s.departments?.color || "#9A7432"} title={s.employees ? `${s.employees.first_name} ${s.employees.last_name}` : "Open shift"}
              subtitle={`${timeIn(s.starts_at, tz)} – ${timeIn(s.ends_at, tz)} · ${s.position || s.departments?.name || ""} · ${app.hotels.find((h) => h.id === s.hotel_id)?.name || ""}`} />
          ))}
        </Card>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({ day: { fontSize: 13, fontWeight: "700", color: colors.secondaryLabel, marginTop: 6, textTransform: "uppercase", letterSpacing: 0.6 } });
