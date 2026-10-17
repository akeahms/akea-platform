import React, { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { auth } from "@/lib/sb";
import { useApp } from "@/lib/app";
import { acceptLegal, legalStatus, legalUrl, LegalStatus } from "@/lib/legal";
import { Button, ErrorText, Loading } from "@/components/ui";
import { brand, space, serif } from "@/theme";

function Check({ on, onPress, children }: { on: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.tick}>✓</Text> : null}</View>
      <Text style={styles.checkText}>{children}</Text>
    </Pressable>
  );
}
const Doc = ({ slug, label }: { slug: string; label: string }) => (
  <Pressable onPress={() => Linking.openURL(legalUrl(slug))} hitSlop={6} accessibilityRole="link"><Text style={styles.doc}>{label} ↗</Text></Pressable>
);

export default function Terms() {
  const { tenantId, brandName } = useApp();
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [user, setUser] = useState(false);
  const [company, setCompany] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { legalStatus(tenantId).then(setStatus, (e) => setErr(e.message)); }, [tenantId]);
  if (!status) return <View style={styles.wrap}>{err ? <ErrorText text={err} /> : <Loading />}</View>;
  const needUser = !status.user_accepted, needCompany = status.is_principal && !status.company_accepted;
  const co = brandName || "your company";
  async function go() {
    if (busy) return;
    setBusy(true); setErr("");
    try { await acceptLegal(tenantId, needCompany); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>{needUser ? "Before you continue" : "Company agreement"}</Text>
      <Text style={styles.sub}>{needUser ? "Please read and accept our terms. They were last updated on October 17, 2026." : `As a Principal, please accept the company agreement for ${co}.`}</Text>
      <View style={{ gap: space.sm }}>
        {needUser && <><Doc slug="terms" label="Terms of Service" /><Doc slug="privacy-policy" label="Privacy Policy" /><Doc slug="acceptable-use" label="Acceptable Use Policy" /><Doc slug="disclaimers" label="Product and Professional Disclaimers" /></>}
        {needCompany && <><Doc slug="subscription-agreement" label="Subscription Agreement" /><Doc slug="dpa" label="Data Processing Addendum" /></>}
      </View>
      {needUser && <Check on={user} onPress={() => setUser(!user)}>I have read and agree to the Terms of Service, Privacy Policy, Acceptable Use Policy and Disclaimers, including individual binding arbitration and the waiver of class actions and jury trials. The app doesn't give accounting, tax, legal, payroll or investment advice.</Check>}
      {needCompany && <Check on={company} onPress={() => setCompany(!company)}>I am authorized to bind {co} and accept the Subscription Agreement and Data Processing Addendum on its behalf.</Check>}
      {err ? <ErrorText text={err} /> : null}
      <Button title="Agree and continue" onPress={go} busy={busy} disabled={(needUser && !user) || (needCompany && !company)} />
      <Pressable onPress={() => auth.signOut()} hitSlop={8}><Text style={styles.link}>I don't agree — sign out</Text></Pressable>
      <Text style={styles.fine}>We record your acceptance with the date, time, version, IP address and device.</Text>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: "center", padding: space.xl, gap: space.lg, backgroundColor: brand.paper },
  title: { fontSize: 30, fontFamily: serif, fontStyle: "italic", color: brand.ink },
  sub: { fontSize: 15, color: brand.ink2, lineHeight: 21 },
  doc: { color: brand.accentText, fontWeight: "600", fontSize: 15 },
  check: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: brand.ink3, alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxOn: { backgroundColor: brand.dark, borderColor: brand.dark },
  tick: { color: brand.onDark, fontWeight: "700" },
  checkText: { flex: 1, fontSize: 14, lineHeight: 20, color: brand.ink },
  link: { color: brand.accentText, fontWeight: "600", fontSize: 15, textAlign: "center" },
  fine: { fontSize: 12, color: brand.ink3, textAlign: "center" },
});
