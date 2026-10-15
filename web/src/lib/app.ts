import { db, currentSession } from "./sb";

export type Level = "none" | "view" | "edit" | "approve" | "admin";
export const LEVEL: Record<Level, number> = { none: 0, view: 1, edit: 2, approve: 3, admin: 4 };

export type Tenant = {
  id: string; name: string; slug: string; brand_name: string | null; logo_url: string | null; accent_color: string | null;
  subdomain: string | null; custom_domain: string | null; email_sender: string | null; plan: string; hotel_limit: number;
};
export type Hotel = {
  id: string; tenant_id: string; entity_id: string | null; name: string; brand_family: string | null; address: string | null;
  city: string | null; state: string | null; zip: string | null; rooms: number; str_id: string | null; property_code: string | null;
  status: "operating" | "development" | "sold"; opening_date: string | null; timezone: string;
};
export type Membership = {
  id: string; tenant_id: string; all_hotels: boolean;
  roles: { key: string; name: string; approval_limit: number | null; role_permissions: { module: string; level: Level }[] };
  tenants: Tenant;
};

export type Ctx = {
  membership: Membership;
  tenant: Tenant;
  hotels: Hotel[];
  can: (module: string, min?: Level) => boolean;
  reload: () => void;
};

export async function loadContext(): Promise<{ membership: Membership | null; hotels: Hotel[] }> {
  const uid = currentSession()?.user.id;
  if (!uid) return { membership: null, hotels: [] };
  const ms = await db.get<Membership>(
    `memberships?select=id,tenant_id,all_hotels,roles(key,name,approval_limit,role_permissions(module,level)),tenants(*)&user_id=eq.${uid}&limit=1`,
  );
  const membership = ms[0] || null;
  if (!membership) return { membership: null, hotels: [] };
  const hotels = await db.get<Hotel>(`hotels?select=*&tenant_id=eq.${membership.tenant_id}&order=status.asc,name.asc`);
  return { membership, hotels };
}

export function makeCan(m: Membership) {
  const map = new Map(m.roles.role_permissions.map((p) => [p.module, LEVEL[p.level] ?? 0]));
  return (module: string, min: Level = "view") => (map.get(module) ?? 0) >= LEVEL[min];
}

// ---------------- formatting ----------------
export const usd = (v: number, d = 0) =>
  (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const usdShort = (v: number) =>
  Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : usd(v);
export const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
export const num = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------- dates (hotel business dates are plain calendar dates) ----------------
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (s: string, n: number) => {
  const [y, m, d] = s.split("-").map(Number);
  return iso(new Date(y, m - 1, d + n));
};
// Business dates follow the hotels' local time (US Central by default), not the viewer's clock.
export const todayIn = (tz = "America/Chicago") => new Date().toLocaleDateString("en-CA", { timeZone: tz });
export const yesterday = (tz?: string) => addDays(todayIn(tz), -1);
export const fmtDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
export type Period = "Day" | "MTD" | "YTD";
export function periodRange(p: Period, end = yesterday()): [string, string] {
  if (p === "Day") return [end, end];
  const [y, m] = end.split("-");
  return p === "MTD" ? [`${y}-${m}-01`, end] : [`${y}-01-01`, end];
}
// Same-weekday comparison: 364 days back
export const lastYear = ([a, b]: [string, string]): [string, string] => [addDays(a, -364), addDays(b, -364)];

// ---------------- KPI math (one definition, mirrors the KPI library) ----------------
export type Totals = {
  rooms_available: number; rooms_sold: number; room_revenue: number; fnb_revenue: number; other_revenue: number;
  out_of_order: number; comp_rooms: number; no_shows: number; arrivals: number; departures: number; in_house_guests: number;
  days: number; sample_days: number;
};
export const zeroTotals = (): Totals => ({
  rooms_available: 0, rooms_sold: 0, room_revenue: 0, fnb_revenue: 0, other_revenue: 0, out_of_order: 0, comp_rooms: 0,
  no_shows: 0, arrivals: 0, departures: 0, in_house_guests: 0, days: 0, sample_days: 0,
});
export function addTotals(a: Totals, r: any): Totals {
  const o = { ...a };
  (Object.keys(o) as (keyof Totals)[]).forEach((k) => (o[k] += Number(r[k] || 0)));
  return o;
}
export const kpi = (t: Totals) => ({
  occ: t.rooms_available ? t.rooms_sold / t.rooms_available : 0,
  adr: t.rooms_sold ? t.room_revenue / t.rooms_sold : 0,
  revpar: t.rooms_available ? t.room_revenue / t.rooms_available : 0,
  total: t.room_revenue + t.fnb_revenue + t.other_revenue,
  trevpar: t.rooms_available ? (t.room_revenue + t.fnb_revenue + t.other_revenue) / t.rooms_available : 0,
});

export async function summary(range: [string, string], hotels: string[] | null) {
  const rows = await db.rpc<any[]>("kpi_summary", { p_from: range[0], p_to: range[1], p_hotels: hotels });
  const byHotel = new Map<string, Totals>();
  let all = zeroTotals();
  rows.forEach((r) => {
    byHotel.set(r.hotel_id, addTotals(zeroTotals(), r));
    all = addTotals(all, r);
  });
  return { all, byHotel };
}

export const REPORT_LABEL: Record<string, string> = {
  final_audit: "Final Audit Report",
  direct_bill_aging: "Direct Bill Aging",
  occupancy_forecast: "Occupancy Forecast",
  all_transactions: "All Transactions",
  clerk_activity: "Clerk Activity",
  revenue_recap_segment: "Revenue Recap Market Segment",
  tax_exempt: "Tax Exempt Report",
  str_monthly: "STR Monthly STAR",
  str_weekly: "STR Weekly STAR",
  ota_statement: "OTA Statement",
  vendor_invoice: "Vendor Invoice",
  unknown: "Unrecognized",
};

// Guess the report type from a file name; the reading engine confirms it later.
export function guessReportType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("star") || n.includes("str_") || /\bstr\b/.test(n)) return n.includes("weekly") ? "str_weekly" : "str_monthly";
  if (n.includes("final") && n.includes("audit")) return "final_audit";
  if (n.includes("aging")) return "direct_bill_aging";
  if (n.includes("forecast")) return "occupancy_forecast";
  if (n.includes("transaction") || n.includes("all charges")) return "all_transactions";
  if (n.includes("clerk")) return "clerk_activity";
  if (n.includes("segment") || n.includes("recap")) return "revenue_recap_segment";
  if (n.includes("exempt")) return "tax_exempt";
  if (n.includes("expedia") || n.includes("booking") || n.includes("corpay") || n.includes("clc")) return "ota_statement";
  if (n.includes("invoice")) return "vendor_invoice";
  return "unknown";
}
