// Terms acceptance for the phone app (same records as the web app: accept_legal / legal_status).
import { db } from "@/lib/sb";
import { PORTAL_URL } from "@/constants";

/** Must match legal_version() in the database and web/src/legal.tsx. */
export const LEGAL_VERSION = "2026-10-17";
export type LegalStatus = { version: string; user_accepted: boolean; is_principal: boolean; company_accepted: boolean };

/** The public website the legal pages live on (the portal URL without /app). */
export const SITE_URL = PORTAL_URL.replace(/\/app\/?$/, "");
export const legalUrl = (slug: string) => `${SITE_URL}/${slug}/`;

export const legalStatus = (tenant: string) => db.rpc<LegalStatus>("legal_status", { p_tenant: tenant });
export const needsAcceptance = (s: LegalStatus) => !s.user_accepted || (s.is_principal && !s.company_accepted);

const listeners = new Set<() => void>();
export const onLegalChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export async function acceptLegal(tenant: string, company: boolean) {
  const s = await db.rpc<LegalStatus>("accept_legal", { p_version: LEGAL_VERSION, p_tenant: tenant, p_company: company });
  listeners.forEach((fn) => fn());
  return s;
}
