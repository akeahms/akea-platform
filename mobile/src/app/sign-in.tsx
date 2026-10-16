import React, { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View, Pressable } from "react-native";
import { auth } from "@/lib/sb";
import { Button, ErrorText } from "@/components/ui";
import { brand, colors, space } from "@/theme";
import { PORTAL_URL, PRODUCT_NAME } from "@/constants";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  async function go() {
    if (busy) return;   // the keyboard "go" key can fire while a request is running
    setBusy(true); setErr(""); setNote("");
    try { await auth.signIn(email.trim(), password); }
    catch (e: any) { setErr(e.message === "Invalid login credentials" ? "That email and password don't match." : e.message); }
    finally { setBusy(false); }
  }
  async function reset() {
    if (!email.trim()) { setErr("Enter your email first, then tap Forgot password."); return; }
    try { await auth.resetPassword(email.trim(), PORTAL_URL); setNote(`If ${email.trim()} has an account, a reset link is on its way.`); }
    catch (e: any) { setErr(e.message); }
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "#FBF7EE" }}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="Akea Hotel Management Services" />
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.sub}>Use the same email and password as {PRODUCT_NAME} on the web.</Text>
        <View style={styles.form}>
          <TextInput style={styles.input} placeholder="Work email" autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username"
            value={email} onChangeText={setEmail} placeholderTextColor="#8A8578" />
          <TextInput style={styles.input} placeholder="Password" secureTextEntry autoComplete="current-password" textContentType="password"
            value={password} onChangeText={setPassword} onSubmitEditing={go} placeholderTextColor="#8A8578" />
          <Button title="Sign in" onPress={go} busy={busy} disabled={!email || !password} />
          {err ? <ErrorText text={err} /> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}
          <Pressable onPress={reset} hitSlop={8}><Text style={styles.link}>Forgot password?</Text></Pressable>
        </View>
        <Text style={styles.fine}>New team members: your manager invites you by email first.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: "center", padding: space.xl, gap: space.md },
  logo: { width: 200, height: 90, alignSelf: "center", marginBottom: space.lg },
  title: { fontSize: 30, fontWeight: "700", color: "#1E2430" },
  sub: { fontSize: 15, color: "#4A5262" },
  form: { gap: space.md, marginTop: space.md },
  input: { backgroundColor: "#FFFFFF", borderRadius: 12, borderWidth: 1, borderColor: "#E7E2D6", paddingHorizontal: 14, paddingVertical: 14, fontSize: 16, color: "#1E2430" },
  link: { color: brand.accent, fontWeight: "600", fontSize: 15, textAlign: "center", marginTop: space.sm },
  note: { color: brand.info, fontSize: 14 },
  fine: { color: "#8A8578", fontSize: 13, textAlign: "center", marginTop: space.xl },
});
void colors;
