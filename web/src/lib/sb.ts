// Minimal Supabase client over fetch: auth (GoTrue), database (PostgREST), storage.
// Kept dependency-free on purpose so the app builds anywhere with only React + esbuild.

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

export const SUPABASE_URL = __SUPABASE_URL__;
const KEY = __SUPABASE_KEY__;
const STORE = "akea.session";

export type User = { id: string; email: string; user_metadata?: Record<string, unknown> };
export type Session = { access_token: string; refresh_token: string; expires_at: number; user: User };

let session: Session | null = load();
const listeners = new Set<(s: Session | null) => void>();

function load(): Session | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function save(s: Session | null) {
  session = s;
  try {
    if (s) localStorage.setItem(STORE, JSON.stringify(s));
    else localStorage.removeItem(STORE);
  } catch {
    /* storage unavailable: keep in memory only */
  }
  listeners.forEach((fn) => fn(s));
}

export function onAuth(fn: (s: Session | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function currentSession() {
  return session;
}

async function errorText(res: Response) {
  try {
    const j = await res.json();
    return j.msg || j.message || j.error_description || j.error || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function toSession(j: any): Session {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600),
    user: j.user,
  };
}

let refreshing: Promise<void> | null = null;
async function ensureFresh() {
  if (!session) return;
  if (session.expires_at - Date.now() / 1000 > 90) return;
  if (!refreshing) {
    refreshing = (async () => {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session!.refresh_token }),
      });
      if (res.ok) save(toSession(await res.json()));
      else save(null);
    })().finally(() => (refreshing = null));
  }
  await refreshing;
}

async function headers(extra: Record<string, string> = {}) {
  await ensureFresh();
  return {
    apikey: KEY,
    Authorization: `Bearer ${session?.access_token || KEY}`,
    ...extra,
  };
}

// ---------------- auth ----------------
export const auth = {
  async signIn(email: string, password: string) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    save(toSession(await res.json()));
  },
  async signUp(email: string, password: string, fullName: string) {
    const redirect = encodeURIComponent(window.location.origin + "/");
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup?redirect_to=${redirect}`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, data: { full_name: fullName } }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const j = await res.json();
    if (j.access_token) save(toSession(j));
    return { needsConfirmation: !j.access_token };
  },
  async resetPassword(email: string) {
    const redirect = encodeURIComponent(window.location.origin + "/");
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${redirect}`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(await errorText(res));
  },
  async updatePassword(password: string) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error(await errorText(res));
  },
  microsoftUrl() {
    const redirect = encodeURIComponent(window.location.origin + "/");
    return `${SUPABASE_URL}/auth/v1/authorize?provider=azure&scopes=email&redirect_to=${redirect}`;
  },
  async signOut() {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: await headers() });
    } finally {
      save(null);
    }
  },
  // After email confirmation / password recovery / OAuth, tokens arrive in the URL hash.
  async consumeRedirect(): Promise<"recovery" | "signin" | null> {
    const h = window.location.hash.startsWith("#access_token=") || window.location.hash.includes("&access_token=")
      ? new URLSearchParams(window.location.hash.slice(1))
      : null;
    if (!h || !h.get("access_token")) return null;
    const access = h.get("access_token")!;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${access}` } });
    if (!res.ok) return null;
    const user = await res.json();
    save({
      access_token: access,
      refresh_token: h.get("refresh_token") || "",
      expires_at: Math.floor(Date.now() / 1000) + Number(h.get("expires_in") || 3600),
      user,
    });
    history.replaceState(null, "", window.location.pathname);
    return h.get("type") === "recovery" ? "recovery" : "signin";
  },
};

// ---------------- database ----------------
async function rest<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: await headers({
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    save(null);
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!res.ok) throw new Error(await errorText(res));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const db = {
  get: <T = any>(pathAndQuery: string) => rest<T[]>("GET", pathAndQuery),
  rpc: <T = any>(fn: string, args: Record<string, unknown>) => rest<T>("POST", `rpc/${fn}`, args),
  insert: <T = any>(table: string, rows: unknown) => rest<T[]>("POST", table, rows, "return=representation"),
  update: <T = any>(table: string, filter: string, patch: unknown) =>
    rest<T[]>("PATCH", `${table}?${filter}`, patch, "return=representation"),
  remove: (table: string, filter: string) => rest<void>("DELETE", `${table}?${filter}`),
};

// ---------------- storage ----------------
export const storage = {
  async upload(bucket: string, path: string, file: File) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: await headers({ "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" }),
      body: file,
    });
    if (!res.ok) throw new Error(await errorText(res));
  },
};
