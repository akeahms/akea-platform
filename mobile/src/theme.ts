import { Platform } from "react-native";
import { Color } from "expo-router";

// Brand accent (overridden by the company's white-label colour once loaded) + native semantic colours.
export const brand = { accent: "#9A7432", accentSoft: "rgba(154,116,50,0.12)", good: "#1F7A4A", warn: "#9A5B00", bad: "#B4372D", info: "#2B5F96" };
export const colors = {
  label: Platform.select({ ios: Color.ios.label, android: Color.android.dynamic.onSurface, default: "#1E2430" })!,
  secondaryLabel: Platform.select({ ios: Color.ios.secondaryLabel, android: Color.android.dynamic.onSurfaceVariant, default: "#6B7383" })!,
  separator: Platform.select({ ios: Color.ios.separator, android: Color.android.dynamic.outlineVariant, default: "#E4E6EB" })!,
  background: Platform.select({ ios: Color.ios.systemGroupedBackground, android: Color.android.dynamic.surface, default: "#F5F6F8" })!,
  card: Platform.select({ ios: Color.ios.secondarySystemGroupedBackground, android: Color.android.dynamic.surfaceContainer, default: "#FFFFFF" })!,
  fill: Platform.select({ ios: Color.ios.tertiarySystemFill, android: Color.android.dynamic.surfaceVariant, default: "#F1F2F5" })!,
};
export const radius = { card: 16, button: 12, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
