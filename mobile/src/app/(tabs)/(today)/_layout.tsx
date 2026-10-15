import React from "react";
import { Stack } from "expo-router/stack";
import { colors } from "@/theme";

export default function Layout() {
  return (
    <Stack screenOptions={{ headerLargeTitleEnabled: true, headerTransparent: true, headerShadowVisible: false, headerLargeTitleShadowVisible: false,
      headerLargeStyle: { backgroundColor: "transparent" }, headerTitleStyle: { color: colors.label as string }, headerBlurEffect: "systemMaterial" }}>
      <Stack.Screen name="index" options={{ title: "Today" }} />
    </Stack>
  );
}
