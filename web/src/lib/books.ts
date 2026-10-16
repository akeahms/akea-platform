// Shared accounting helpers: chart of accounts per hotel, vendors, bank accounts.
import { db, storage } from "./sb";
import { useAsync } from "../ui";
import type { Ctx } from "./app";

export type Gl = { id: string; hotel_id: string | null; number: string; name: string; full_name: string; type: string; section: string | null; active: boolean;
  parent_id: string | null; qbo_type: string | null; detail_type: string | null; system_key: string | null; template_id: string | null };
export type Vendor = { id: string; name: string; dba: string | null; category: string | null; contact_name: string | null; email: string | null; phone: string | null; address: string | null;
  payment_terms: string | null; default_gl: string | null; remit_method: string; w9_on_file: boolean; tax_id_last4: string | null; is_1099: boolean; status: string; notes: string | null; data_source: string };
export type Bill = { id: string; hotel_id: string; vendor_id: string | null; po_id: string | null; invoice_no: string | null; invoice_date: string | null; due_date: string | null; amount: number;
  gl_account_id: string | null; description: string | null; status: string; file_path: string | null; approved_at: string | null; paid_at: string | null; scheduled_for: string | null;
  payment_method: string | null; payment_ref: string | null; decision_note: string | null; data_source: string; source: string };
export type BankAcct = { id: string; hotel_id: string; name: string; institution: string | null; last4: string | null; kind: string; feed: string; balance: number | null; balance_as_of: string | null; last_synced_at: string | null; data_source: string;
  gl_account_id?: string | null; next_check_number?: number; check_layout?: CheckLayout; check_offset_x?: number; check_offset_y?: number; check_print_company?: boolean };
export type CheckLayout = "voucher_top" | "voucher_middle" | "voucher_bottom" | "standard3";

export const BILL_STATUS: Record<string, [string, "good" | "warn" | "bad" | "info" | "mute"]> = {
  draft: ["Draft", "mute"], pending_approval: ["Waiting for approval", "warn"], approved: ["Approved · to pay", "info"], scheduled: ["Payment scheduled", "info"],
  paid: ["Paid", "good"], rejected: ["Rejected", "bad"], void: ["Void", "mute"],
};
export const sanitize = (n: string) => n.replace(/[^\w.\- ]+/g, "_");
export function useLookups(ctx: Ctx) {
  return useAsync(async () => {
    const [gl, vendors] = await Promise.all([
      db.getAll<Gl>(`gl_accounts?select=id,hotel_id,number,name,full_name,type,section,active,parent_id,qbo_type,detail_type,system_key,template_id&tenant_id=eq.${ctx.tenant.id}&order=number.asc,id.asc`),
      db.getAll<Vendor>(`vendors?select=*&tenant_id=eq.${ctx.tenant.id}&order=name.asc,id.asc`),
    ]);
    return { gl, vendors };
  }, [ctx.tenant.id]);
}
export const glLabel = (g?: Gl) => (g ? `${g.number} · ${g.full_name || g.name}${g.active ? "" : " (Inactive)"}` : "—");
// Each hotel has its own chart of accounts (hotel_id = that hotel); hotel_id = null is the company template.
export const glOf = (gl: Gl[] | undefined, hotelId: string | null | undefined) => (gl || []).filter((g) => (hotelId ? g.hotel_id === hotelId : !g.hotel_id));
/** Accounts that can be picked for new entries: active ones (plus the one already chosen, so an old record still shows its account). */
export const glPick = (gl: Gl[] | undefined, hotelId: string | null | undefined, current?: string | null) =>
  glOf(gl, hotelId).filter((g) => g.active || g.id === current).sort((a, b) => (a.full_name || a.name).localeCompare(b.full_name || b.name));
/** The hotel's own account matching an id (a template default such as a vendor's default account maps through the template link or the name). */
export const ownGl = (gl: Gl[] | undefined, id: string | null | undefined, hotelId: string) => {
  const g = (gl || []).find((x) => x.id === id);
  if (!g) return "";
  if (g.hotel_id === hotelId) return g.id;
  const mine = (gl || []).find((x) => x.hotel_id === hotelId && (x.template_id === g.id || (g.system_key && x.system_key === g.system_key) || x.full_name.toLowerCase() === g.full_name.toLowerCase()));
  return mine && mine.active ? mine.id : "";
};
export async function openFile(path: string) {
  const url = await storage.signedUrl("vault", path, 120);
  window.open(url, "_blank", "noopener");
}

