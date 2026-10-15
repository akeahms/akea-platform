import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { restoreSession, onAuth, currentSession, mfa } from "@/lib/sb";
import { AppProvider, loadMembership } from "@/lib/app";

SplashScreen.preventAutoHideAsync().catch(() => {});

type Status = "loading" | "signed-out" | "two-step" | "no-access" | "ready";

export default function RootLayout() {
  const [status, setStatus] = useState<Status>("loading");
  const [membership, setMembership] = useState<any>(null);

  async function evaluate() {
    if (!currentSession()) { setMembership(null); setStatus("signed-out"); return; }
    try {
      const m = await loadMembership();
      if (!m) { setStatus("no-access"); return; }
      setMembership(m);
      if (mfa.level() !== "aal2") {
        const verified = (await mfa.factors().catch(() => [])).some((f) => f.status === "verified");
        if (m.roles?.requires_mfa || verified) { setStatus("two-step"); return; }
      }
      setStatus("ready");
    } catch {
      setStatus(currentSession() ? "no-access" : "signed-out");
    }
  }

  useEffect(() => {
    restoreSession().then(evaluate);
    return onAuth(() => { evaluate(); });
  }, []);
  useEffect(() => { if (status !== "loading") SplashScreen.hideAsync().catch(() => {}); }, [status]);
  if (status === "loading") return null;

  const stack = (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === "signed-out"}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={status === "two-step"}>
        <Stack.Screen name="two-step" />
      </Stack.Protected>
      <Stack.Protected guard={status === "no-access"}>
        <Stack.Screen name="no-access" />
      </Stack.Protected>
      <Stack.Protected guard={status === "ready"}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
    </Stack>
  );
  return (
    <>
      <StatusBar style="auto" />
      {membership ? <AppProvider membership={membership}>{stack}</AppProvider> : stack}
    </>
  );
}
