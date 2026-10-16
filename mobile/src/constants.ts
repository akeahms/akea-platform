import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra || {}) as Record<string, string>;
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || extra.supabaseUrl;
export const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY || extra.supabaseKey;
export const PORTAL_URL = extra.portalUrl || "https://akea-portal.onrender.com";
/** White-label product name for this build (Akea: "Akea AI Suite"). */
export const PRODUCT_NAME = extra.productName || "the web app";
