import { Platform } from "react-native";
import { Color } from "expo-router";

// Stone & Forest brand (bronze accent, forest ink, stone/paper grounds) + native semantic colours.
export const brand = { accent: "#9C7A43", accentSoft: "rgba(156,122,67,0.12)", accentText: "#7A5D30", dark: "#14241F", onDark: "#EDE6D8",
  paper: "#F5F2EC", stone: "#E4DED3", line: "#DDD5C7", ink: "#14241F", ink2: "#2E3F39", ink3: "#5F5A51",
  good: "#2D6A4F", warn: "#8A5A12", bad: "#A63D2F", info: "#2E5A55" };
/** The brand's display face: an italic serif close to the kit's Cormorant Garamond (system fonts, nothing to download). */
export const serif = Platform.select({ ios: "Georgia", android: "serif", default: "Georgia" })!;
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
