import { db, currentSession } from "./sb";

export type Level = "none" | "view" | "edit" | "approve" | "admin";
export const LEVEL: Record<Level, number> = { none: 0, view: 1, edit: 2, approve: 3, admin: 4 };

export type Tenant = {
  id: string; name: string; slug: string; brand_name: string | null; logo_url: string | null; accent_color: string | null;
  dark_color?: string | null; logo_light_url?: string | null;
  subdomain: string | null; custom_domain: string | null; email_sender: string | null; plan: string; hotel_limit: number; report_inbox?: string | null; product_name?: string | null;
};
/** The software's name as this company's people see it (white-label): Akea's is "Akea AI Suite"; other companies set their own. */
export const productName = (t?: Partial<Tenant> | null) => (t?.product_name || t?.brand_name || t?.name || "").trim() || "the app";
let APP_NAME = "the app";
/** The current company's software name; "the app" before anyone has signed in. */
export const appName = () => APP_NAME;
export const setAppName = (t?: Partial<Tenant> | null) => { APP_NAME = productName(t); };
/** Public branding for the web address being used (sign-in page, before anyone has signed in). */
export type Branding = { name?: string; brand_name?: string | null; product_name?: string; logo_url?: string | null; logo_light_url?: string | null;
  accent_color?: string | null; dark_color?: string | null };
export async function loadBranding(): Promise<Branding | null> {
  try {
    const b = await db.rpc<Branding | null>("public_branding", { p_host: location.hostname });
    if (b) setAppName(b as Partial<Tenant>);
    return b || null;
  } catch { return null; }
}
/** Only https images (or our own files) are used as a logo. */
export const safeLogo = (u?: string | null, fallback = "logo.png") => (u && /^https:\/\//i.test(u) ? u : fallback);
/** Only a #rrggbb colour is used as the accent. */
export const safeColor = (c?: string | null) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
/** The company's colours on the page: accent (highlights) and dark colour (side menu, main buttons). Defaults are the
 *  built-in Stone & Forest theme. */
let LOGO = "logo.svg";
/** The logo of the company whose theme is showing (for screens outside the main layout, e.g. two-step sign-in). */
export const currentLogo = () => LOGO;
export function applyTheme(b?: Branding | Partial<Tenant> | null) {
  LOGO = logoFor(b);
  const root = document.documentElement.style;
  const accent = safeColor(b?.accent_color), dark = safeColor(b?.dark_color);
  if (accent) root.setProperty("--accent", accent); else root.removeProperty("--accent");
  if (dark) root.setProperty("--brand", dark); else root.removeProperty("--brand");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark || "#14241F");
}
/** Logo for light backgrounds; the built-in wordmark when the company hasn't set one. */
export const logoFor = (b?: Branding | Partial<Tenant> | null) => safeLogo(b?.logo_url, "logo.svg");
/** Logo for dark backgrounds: the light logo, else null (the page then shows the normal logo on a light plate). */
export const lightLogoFor = (b?: Branding | Partial<Tenant> | null) =>
  b?.logo_light_url && /^https:\/\//i.test(b.logo_light_url) ? b.logo_light_url : !b?.logo_url ? "logo-light.svg" : null;
export type Hotel = {
  id: string; tenant_id: string; entity_id: string | null; name: string; brand_family: string | null; address: string | null;
  city: string | null; state: string | null; zip: string | null; rooms: number; str_id: string | null; property_code: string | null;
  status: "operating" | "development" | "sold"; opening_date: string | null; timezone: string; report_email?: string | null;
};
export type Membership = {
  id: string; tenant_id: string; all_hotels: boolean;
  roles: { key: string; name: string; approval_limit: number | null; requires_mfa: boolean; role_permissions: { module: string; level: Level }[] };
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
    `memberships?select=id,tenant_id,all_hotels,roles(key,name,approval_limit,requires_mfa,role_permissions(module,level)),tenants(*)&user_id=eq.${uid}&limit=1`,
  );
  const membership = ms[0] || null;
  if (!membership) return { membership: null, hotels: [] };
  setAppName(membership.tenants);
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

// ---------------- time in a hotel's own time zone ----------------
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    dtfCache.set(tz, f);
  }
  const o: Record<string, number> = {};
  f.formatToParts(new Date(ts)).forEach((p) => p.type !== "literal" && (o[p.type] = Number(p.value)));
  return o;
}
/** "2026-10-16" + "07:30" in America/Chicago -> UTC ISO string */
export function wallToUtc(date: string, time: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = parts(guess, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const off = asUtc - guess;
  let ts = guess - off;
  const p2 = parts(ts, tz); // correct across DST changes
  const off2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second) - ts;
  if (off2 !== off) ts = guess - off2;
  return new Date(ts).toISOString();
}
/** UTC timestamp -> { date: "YYYY-MM-DD", time: "HH:MM", mins } in the hotel's zone */
export function inTz(ts: string, tz: string) {
  const p = parts(Date.parse(ts), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}`, mins: p.hour * 60 + p.minute };
}
export function fmtClock(ts: string, tz: string) {
  const { mins } = inTz(ts, tz);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
}
export function weekStart(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 Sun
  return addDays(date, -((dow + 6) % 7));
}
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const hoursBetween = (a: string, b: string, breakMin = 0) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3.6e6 - breakMin / 60);
export const hrs = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")} h`;
