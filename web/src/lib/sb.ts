// Minimal Supabase client over fetch: auth (GoTrue), database (PostgREST), storage.
// Kept dependency-free on purpose so the app builds anywhere with only React + esbuild.

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

export const SUPABASE_URL = __SUPABASE_URL__;
const KEY = __SUPABASE_KEY__;
const STORE = "akea.session";

/** Where the app lives (e.g. https://akeahms.com/app/): sign-in emails and redirects come back here. */
const appUrl = () => new URL("./", document.baseURI).href;

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

// another tab signed in, refreshed or signed out: follow it (the refresh token rotates, so tabs must share it)
if (typeof window !== "undefined") window.addEventListener("storage", (e) => {
  if (e.key !== STORE) return;
  session = load();
  listeners.forEach((fn) => fn(session));
});

let refreshing: Promise<void> | null = null;
async function refreshNow() {
  // one tab at a time (Web Locks): re-read storage inside the lock, since another tab may already have refreshed
  const run = async () => {
    const stored = load();
    if (stored && session && stored.refresh_token !== session.refresh_token && stored.expires_at - Date.now() / 1000 > 90) { session = stored; return; }
    if (!session) return;
    let res: Response;
    try {
      res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
    } catch { return; }                                   // offline: keep the session and try again on the next request
    if (res.ok) save(toSession(await res.json()));
    else if (res.status === 400 || res.status === 401) save(null);   // the sign-in really ended (revoked or expired)
    // 429 / 5xx: a temporary problem on the server, so stay signed in
  };
  const locks = (typeof navigator !== "undefined" && (navigator as any).locks) || null;
  if (locks) await locks.request("akea.auth.refresh", run); else await run();
}
async function ensureFresh(force = false) {
  if (!session) return;
  if (!force && session.expires_at - Date.now() / 1000 > 90) return;
  if (!refreshing) refreshing = refreshNow().finally(() => (refreshing = null));
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
    const redirect = encodeURIComponent(appUrl());
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
  // Passwordless: email a one-time sign-in link (existing accounts only).
  async emailLink(email: string) {
    const redirect = encodeURIComponent(appUrl());
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${redirect}`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: false }),
    });
    if (!res.ok) throw new Error(await errorText(res));
  },
  async resetPassword(email: string) {
    const redirect = encodeURIComponent(appUrl());
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
  // Which social providers are switched on in Supabase (public endpoint).
  async providers(): Promise<Record<string, boolean>> {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: KEY } });
      if (!res.ok) return {};
      const j = await res.json();
      return j.external || {};
    } catch {
      return {};
    }
  },
  oauthUrl(provider: string) {
    const redirect = encodeURIComponent(appUrl());
    const scopes = provider === "azure" ? "&scopes=email" : "";
    return `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}${scopes}&redirect_to=${redirect}`;
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

// ---------------- two-factor (TOTP authenticator apps) ----------------
export type Factor = { id: string; friendly_name?: string; factor_type: string; status: "verified" | "unverified" };

function jwtClaims(token?: string): Record<string, any> {
  try {
    const p = (token || "").split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

export const mfa = {
  level(): "aal1" | "aal2" {
    return jwtClaims(session?.access_token).aal === "aal2" ? "aal2" : "aal1";
  },
  async factors(): Promise<Factor[]> {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: await headers() });
    if (!res.ok) throw new Error(await errorText(res));
    const u = await res.json();
    return (u.factors || []).filter((f: Factor) => f.factor_type === "totp");
  },
  async enroll(name: string): Promise<{ id: string; qr: string; secret: string }> {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/factors`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ factor_type: "totp", friendly_name: name, issuer: (typeof document !== "undefined" && document.title) || "Sign-in" }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const j = await res.json();
    // The QR arrives as SVG markup (sometimes as an unencoded data URL); encode it so every browser can show it.
    const raw: string = j.totp.qr_code || "";
    const svg = raw.startsWith("<") ? raw : raw.replace(/^data:image\/svg\+xml;(?:utf-8|charset=utf-8)?,/, "");
    const qr = svg.startsWith("<") ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : raw;
    return { id: j.id, qr, secret: j.totp.secret };
  },
  async verify(factorId: string, code: string) {
    const c = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}/challenge`, { method: "POST", headers: await headers({ "Content-Type": "application/json" }), body: "{}" });
    if (!c.ok) throw new Error(await errorText(c));
    const { id: challenge_id } = await c.json();
    const v = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}/verify`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ challenge_id, code }),
    });
    if (!v.ok) {
      const t = await errorText(v);
      throw new Error(/invalid|expired/i.test(t) ? "That code didn't work. Check your authenticator app and try the newest code." : t);
    }
    const j = await v.json();
    save({ ...toSession(j), user: j.user || session!.user });
  },
  async remove(factorId: string) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}`, { method: "DELETE", headers: await headers() });
    if (!res.ok) throw new Error(await errorText(res));
  },
};

// ---------------- server functions ----------------
export async function callFunction<T = any>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: await headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

// ---------------- database ----------------
async function rest<T>(method: string, path: string, body?: unknown, prefer?: string, retried = false): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: await headers({
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    // the access token may have just expired: refresh once and repeat the request before giving up
    if (!retried && session) { await ensureFresh(true); if (session) return rest<T>(method, path, body, prefer, true); }
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
  /** Every matching row, 1,000 at a time (a single read stops at 1,000). The query needs a stable order. */
  async getAll<T = any>(pathAndQuery: string, cap = 50000): Promise<T[]> {
    const out: T[] = [];
    const sep = pathAndQuery.includes("?") ? "&" : "?";
    for (let offset = 0; offset < cap; offset += 1000) {
      const page = await rest<T[]>("GET", `${pathAndQuery}${sep}limit=1000&offset=${offset}`);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  },
  rpc: <T = any>(fn: string, args: Record<string, unknown>) => rest<T>("POST", `rpc/${fn}`, args),
  insert: <T = any>(table: string, rows: unknown, select = "*") => rest<T[]>("POST", `${table}?select=${select}`, rows, "return=representation"),
  update: <T = any>(table: string, filter: string, patch: unknown, select = "*") =>
    rest<T[]>("PATCH", `${table}?${filter}&select=${select}`, patch, "return=representation"),
  upsert: <T = any>(table: string, rows: unknown, onConflict: string, select = "*") =>
    rest<T[]>("POST", `${table}?on_conflict=${onConflict}&select=${select}`, rows, "return=representation,resolution=merge-duplicates"),
  remove: (table: string, filter: string) => rest<void>("DELETE", `${table}?${filter}`),
};

// ---------------- storage ----------------
export const storage = {
  async signedUrl(bucket: string, path: string, seconds = 300) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: seconds }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const j = await res.json();
    return `${SUPABASE_URL}/storage/v1${j.signedURL}`;
  },
  async download(bucket: string, path: string): Promise<Blob> {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: await headers() });
    if (!res.ok) throw new Error(await errorText(res));
    return res.blob();
  },
  async upload(bucket: string, path: string, file: File) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: await headers({ "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" }),
      body: file,
    });
    if (!res.ok) throw new Error(await errorText(res));
  },
};
