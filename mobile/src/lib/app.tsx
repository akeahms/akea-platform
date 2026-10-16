import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { db, currentSession } from "./sb";

export type Level = "none" | "view" | "edit" | "approve" | "admin";
const LV: Record<Level, number> = { none: 0, view: 1, edit: 2, approve: 3, admin: 4 };
export type Hotel = { id: string; name: string; city: string | null; rooms: number; status: string; timezone: string };
export type Employee = { id: string; hotel_id: string; first_name: string; last_name: string; position: string | null; department_id: string | null };
export type AppData = {
  tenantId: string; userId: string; brandName: string; accent: string | null; roleName: string; roleKey: string; requiresMfa: boolean;
  hotels: Hotel[]; employee: Employee | null; can: (module: string, min?: Level) => boolean; reload: () => void;
};

const Ctx = createContext<AppData | null>(null);
export const useApp = () => useContext(Ctx)!;

export async function loadMembership() {
  const uid = currentSession()?.user.id;
  const ms = await db.get<any>(`memberships?select=id,tenant_id,roles(key,name,requires_mfa,role_permissions(module,level)),tenants(name,brand_name,accent_color)&user_id=eq.${uid}&limit=1`);
  return ms[0] || null;
}

export function AppProvider({ membership, children }: { membership: any; children: React.ReactNode }) {
  const [tick, setTick] = useState(0);
  const [extra, setExtra] = useState<{ hotels: Hotel[]; employee: Employee | null }>({ hotels: [], employee: null });
  useEffect(() => {
    const uid = currentSession()?.user.id;
    Promise.all([
      db.get<Hotel>(`hotels?select=id,name,city,rooms,status,timezone&tenant_id=eq.${membership.tenant_id}&order=name.asc`).catch(() => []),
      db.get<Employee>(`employees?select=id,hotel_id,first_name,last_name,position,department_id&user_id=eq.${uid}&status=eq.active&limit=1`).catch(() => []),
    ]).then(([hotels, emp]) => setExtra({ hotels, employee: emp[0] || null }));
  }, [membership.tenant_id, tick]);
  // coming back to the app refreshes hotels and the employee link (e.g. after a manager changes them)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") setTick((t) => t + 1); });
    return () => sub.remove();
  }, []);
  const perms = new Map<string, number>((membership.roles?.role_permissions || []).map((p: any) => [p.module, LV[p.level as Level] ?? 0]));
  const value: AppData = {
    tenantId: membership.tenant_id, userId: currentSession()?.user.id || "", brandName: membership.tenants?.brand_name || membership.tenants?.name || "Akea",
    accent: membership.tenants?.accent_color || null, roleName: membership.roles?.name || "", roleKey: membership.roles?.key || "",
    requiresMfa: !!membership.roles?.requires_mfa, ...extra,
    can: (m, min = "view") => (perms.get(m) ?? 0) >= LV[min], reload: () => setTick((t) => t + 1),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Load data for a screen; `refresh()` re-runs it (pull-to-refresh). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    return fn().then((data) => setState({ data, loading: false }), (e) => setState({ error: e?.message || String(e), loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, refresh: run };
}

// ---------------- formatting & dates ----------------
export const usd = (v: number, d = 0) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
export const dayIn = (tz = "America/Chicago", offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
};
export const timeIn = (iso: string, tz = "America/Chicago") => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
export const dateLabel = (iso: string, tz = "America/Chicago") => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
/** The UTC instant of midnight at the start of `date` (YYYY-MM-DD) in a time zone. */
export function midnightUtc(date: string, tz = "America/Chicago"): string {
  const guess = Date.parse(date + "T00:00:00Z");
  const offset = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value || 0);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ms;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first)).toISOString();   // second pass handles days when clocks change
}
/** Monday (YYYY-MM-DD) of the week containing `date`. */
export const mondayOf = (date: string) => { const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
export const hoursBetween = (a: string, b: string, breakMin = 0) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3.6e6 - breakMin / 60);
