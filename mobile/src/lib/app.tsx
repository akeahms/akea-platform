import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { db, currentSession } from "./sb";

export type Level = "none" | "view" | "edit" | "approve" | "admin";
const LV: Record<Level, number> = { none: 0, view: 1, edit: 2, approve: 3, admin: 4 };
export type Hotel = { id: string; name: string; city: string | null; rooms: number; status: string; timezone: string };
export type Employee = { id: string; hotel_id: string; first_name: string; last_name: string; position: string | null; department_id: string | null };
export type AppData = {
  tenantId: string; brandName: string; accent: string | null; roleName: string; roleKey: string; requiresMfa: boolean;
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
  const perms = new Map<string, number>((membership.roles?.role_permissions || []).map((p: any) => [p.module, LV[p.level as Level] ?? 0]));
  const value: AppData = {
    tenantId: membership.tenant_id, brandName: membership.tenants?.brand_name || membership.tenants?.name || "Akea",
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
export const hoursBetween = (a: string, b: string, breakMin = 0) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3.6e6 - breakMin / 60);
