// Small Supabase client over fetch (same API as the web app). Only the refresh token and user id/email are kept in the
// device keychain (SecureStore values are limited to ~2 KB); a fresh access token is fetched on launch.
import * as SecureStore from "expo-secure-store";
import { SUPABASE_URL, SUPABASE_KEY } from "@/constants";

export type Session = { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email: string } };
const KEY = "akea.session";
let session: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();

export async function restoreSession() {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const kept = raw ? JSON.parse(raw) : null;
    // no access token is stored: expires_at 0 makes the first request refresh it
    session = kept?.refresh_token ? { access_token: "", refresh_token: kept.refresh_token, expires_at: 0, user: kept.user } : null;
  } catch { session = null; }
  return session;
}
let saveError = "";
/** Why the sign-in couldn't be remembered on this device (shown on the account screen), or "". */
export const sessionSaveError = () => saveError;
async function save(s: Session | null) {
  session = s;
  try {
    if (s) await SecureStore.setItemAsync(KEY, JSON.stringify({ refresh_token: s.refresh_token, user: { id: s.user.id, email: s.user.email } }));
    else await SecureStore.deleteItemAsync(KEY);
    saveError = "";
  } catch (e) { saveError = "This phone couldn't save your sign-in, so you may need to sign in again next time."; }
  listeners.forEach((fn) => fn(s));
}

/** fetch with a 15-second limit and a plain-English message when there's no connection. */
async function tfetch(url: string, opts: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw new Error((e as Error).name === "AbortError" ? "The server took too long to answer. Check your connection and try again." : "No connection. Check your signal or Wi-Fi and try again."); }
  finally { clearTimeout(t); }
}
export const onAuth = (fn: (s: Session | null) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const currentSession = () => session;

async function errorText(res: Response) {
  try { const j = await res.json(); return j.msg || j.message || j.error_description || j.error || `${res.status}`; } catch { return `${res.status} ${res.statusText}`; }
}
const toSession = (j: any): Session => ({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), user: { id: j.user?.id, email: j.user?.email } });

let refreshing: Promise<void> | null = null;
async function ensureFresh(force = false) {
  if (!session || (!force && session.expires_at - Date.now() / 1000 > 90)) return;
  refreshing ??= (async () => {
    let res: Response;
    try {
      res = await tfetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: session!.refresh_token }) });
    } catch { return; }                                              // offline: stay signed in, try again later
    if (res.ok) await save(toSession(await res.json()));
    else if (res.status === 400 || res.status === 401) await save(null);   // the sign-in really ended
    // 429 / 5xx: temporary server trouble, so stay signed in
  })().finally(() => (refreshing = null));
  await refreshing;
}
async function headers(extra: Record<string, string> = {}) {
  await ensureFresh();
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${session?.access_token || SUPABASE_KEY}`, ...extra };
}

export const auth = {
  async signIn(email: string, password: string) {
    const res = await tfetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!res.ok) throw new Error(await errorText(res));
    await save(toSession(await res.json()));
  },
  async resetPassword(email: string, portalUrl: string) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(portalUrl + "/")}`, { method: "POST", headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    if (!res.ok) throw new Error(await errorText(res));
  },
  async signOut() {
    try { await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: await headers() }); } finally { await save(null); }
  },
};

// two-step sign-in (authenticator app codes)
function claims(t?: string): any { try { return JSON.parse(globalThis.atob((t || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; } }
export const mfa = {
  level: () => (claims(session?.access_token).aal === "aal2" ? "aal2" : "aal1"),
  async factors(): Promise<{ id: string; status: string; factor_type: string }[]> {
    const res = await tfetch(`${SUPABASE_URL}/auth/v1/user`, { headers: await headers() });
    if (!res.ok) throw new Error(await errorText(res));
    return ((await res.json()).factors || []).filter((f: any) => f.factor_type === "totp");
  },
  async verify(factorId: string, code: string) {
    const c = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}/challenge`, { method: "POST", headers: await headers({ "Content-Type": "application/json" }), body: "{}" });
    if (!c.ok) throw new Error(await errorText(c));
    const { id } = await c.json();
    const v = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}/verify`, { method: "POST", headers: await headers({ "Content-Type": "application/json" }), body: JSON.stringify({ challenge_id: id, code }) });
    if (!v.ok) { const t = await errorText(v); throw new Error(/invalid|expired/i.test(t) ? "That code didn't work. Try the newest code in your authenticator app." : t); }
    const j = await v.json();
    await save({ ...toSession(j), user: session?.user || toSession(j).user });
  },
};

async function rest<T>(method: string, path: string, body?: unknown, prefer?: string, retried = false): Promise<T> {
  const res = await tfetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: await headers({ "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }), body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    if (!retried && session) { await ensureFresh(true); if (session) return rest<T>(method, path, body, prefer, true); }
    await save(null); throw new Error("Your session ended. Please sign in again.");
  }
  if (!res.ok) throw new Error(await errorText(res));
  if (res.status === 204) return undefined as T;
  const t = await res.text();
  return (t ? JSON.parse(t) : undefined) as T;
}
export const db = {
  get: <T = any>(q: string) => rest<T[]>("GET", q),
  rpc: <T = any>(fn: string, args: Record<string, unknown>) => rest<T>("POST", `rpc/${fn}`, args),
  insert: <T = any>(table: string, rows: unknown, select = "id") => rest<T[]>("POST", `${table}?select=${select}`, rows, "return=representation"),
  /** insert, or leave alone rows that already exist (e.g. "mark as read" done on another device) */
  upsert: <T = any>(table: string, rows: unknown, onConflict: string) => rest<T[]>("POST", `${table}?on_conflict=${onConflict}`, rows, "return=minimal,resolution=ignore-duplicates"),
};
