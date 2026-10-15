import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View, Pressable } from "react-native";
import { mfa, auth } from "@/lib/sb";
import { Button, ErrorText, Loading } from "@/components/ui";
import { brand, space } from "@/theme";

export default function TwoStep() {
  const [factor, setFactor] = useState<string | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { mfa.factors().then((fs) => setFactor(fs.find((f) => f.status === "verified")?.id || null), (e) => setErr(e.message)); }, []);
  async function verify() {
    if (!factor) return;
    setBusy(true); setErr("");
    try { await mfa.verify(factor, code); } catch (e: any) { setErr(e.message); setCode(""); } finally { setBusy(false); }
  }
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Two-step sign-in</Text>
      {factor === undefined && !err ? <Loading /> : factor ? (
        <>
          <Text style={styles.sub}>Open your authenticator app and enter the 6-digit code for Akea Portal.</Text>
          <TextInput style={styles.code} value={code} onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad"
            textContentType="oneTimeCode" autoComplete="one-time-code" autoFocus placeholder="123456" placeholderTextColor="#B9B3A6" onSubmitEditing={verify} />
          <Button title="Verify" onPress={verify} busy={busy} disabled={code.length !== 6} />
        </>
      ) : (
        <Text style={styles.sub}>Your role needs two-step sign-in. Set it up once on the web portal (Sign-in & Security), then come back and sign in here.</Text>
      )}
      {err ? <ErrorText text={err} /> : null}
      <Pressable onPress={() => auth.signOut()} hitSlop={8}><Text style={styles.link}>Sign out</Text></Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg, backgroundColor: "#FBF7EE" },
  title: { fontSize: 28, fontWeight: "700", color: "#1E2430" },
  sub: { fontSize: 15, color: "#4A5262", lineHeight: 21 },
  code: { backgroundColor: "#FFFFFF", borderRadius: 14, borderWidth: 1, borderColor: "#E7E2D6", paddingVertical: 16, fontSize: 30, letterSpacing: 10, textAlign: "center", color: "#1E2430", fontVariant: ["tabular-nums"] },
  link: { color: brand.accent, fontWeight: "600", fontSize: 15, textAlign: "center" },
});
