import React from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { brand, colors, radius, space } from "@/theme";

export function Screen({ children, refreshing, onRefresh }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.background }} contentContainerStyle={styles.screen}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={brand.accent} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Card({ title, children, style, right }: { title?: string; children: React.ReactNode; style?: ViewStyle; right?: React.ReactNode }) {
  return (
    <View style={[styles.card, style]}>
      {(title || right) && (
        <View style={styles.cardHead}>
          {title ? <Text style={styles.cardTitle}>{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Button({ title, onPress, kind = "primary", disabled, busy, big }: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; busy?: boolean; big?: boolean }) {
  const bg = kind === "primary" ? brand.accent : kind === "danger" ? brand.bad : colors.fill;
  const fg = kind === "secondary" ? colors.label : "#FFFFFF";
  return (
    <Pressable accessibilityRole="button" disabled={disabled || busy}
      onPress={() => { Haptics.selectionAsync().catch(() => {}); onPress(); }}
      style={({ pressed }) => [styles.btn, big && styles.btnBig, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, big && styles.btnTextBig, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Pill({ text, tone = "mute" }: { text: string; tone?: "good" | "warn" | "bad" | "info" | "mute" }) {
  const c = tone === "mute" ? (colors.secondaryLabel as string) : brand[tone];
  return <View style={[styles.pill, { backgroundColor: tone === "mute" ? colors.fill : c + "1F" }]}><Text style={[styles.pillText, { color: c }]}>{text}</Text></View>;
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

export function Row({ title, subtitle, right, onPress, stripe }: { title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; stripe?: string }) {
  const body = (
    <View style={styles.row}>
      {stripe ? <View style={[styles.stripe, { backgroundColor: stripe }]} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={styles.rowSub} numberOfLines={3}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>{body}</Pressable> : body;
}

export const Empty = ({ title, sub }: { title: string; sub?: string }) => (
  <View style={styles.empty}><Text style={styles.emptyTitle}>{title}</Text>{sub ? <Text style={styles.emptySub}>{sub}</Text> : null}</View>
);
export const ErrorText = ({ text }: { text: string }) => <Text style={styles.error} selectable>{text}</Text>;
export const Loading = () => <View style={styles.empty}><ActivityIndicator color={brand.accent} /></View>;

const styles = StyleSheet.create({
  screen: { padding: space.lg, gap: space.lg, paddingBottom: 48 },
  card: { backgroundColor: colors.card, borderRadius: radius.card, padding: space.lg, gap: space.md, borderCurve: "continuous" },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 13, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: brand.accent },
  btn: { borderRadius: radius.button, paddingVertical: 13, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", minHeight: 48, borderCurve: "continuous" },
  btnBig: { paddingVertical: 22, minHeight: 72, borderRadius: 18 },
  btnText: { fontSize: 16, fontWeight: "700" },
  btnTextBig: { fontSize: 20 },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" },
  pillText: { fontSize: 12, fontWeight: "700" },
  stat: { flex: 1, minWidth: 130, backgroundColor: colors.card, borderRadius: radius.card, padding: space.md, gap: 2, borderCurve: "continuous" },
  statLabel: { fontSize: 12, fontWeight: "600", color: colors.secondaryLabel },
  statValue: { fontSize: 24, fontWeight: "700", color: colors.label, fontVariant: ["tabular-nums"] },
  statSub: { fontSize: 12, color: colors.secondaryLabel },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10 },
  stripe: { width: 4, alignSelf: "stretch", borderRadius: 2 },
  rowTitle: { fontSize: 16, fontWeight: "600", color: colors.label },
  rowSub: { fontSize: 13, color: colors.secondaryLabel, marginTop: 2 },
  empty: { alignItems: "center", paddingVertical: 28, gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: colors.label, textAlign: "center" },
  emptySub: { fontSize: 14, color: colors.secondaryLabel, textAlign: "center" },
  error: { color: brand.bad, fontSize: 14 },
});
