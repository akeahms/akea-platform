// Click-to-accept for the Terms (each person) and the Subscription Agreement (a Principal, for the company),
// plus the short notices shown on pages where a disclaimer matters. The documents themselves live on the website
// (/terms/, /privacy-policy/ …), built from web/site/legal.json.
import React, { useState } from "react";
import { auth, db } from "./lib/sb";
import { logoFor } from "./lib/app";

/** Must match legal_version() in the database and "version" in web/site/legal.json. */
export const LEGAL_VERSION = "2026-10-17";

export type LegalStatus = { version: string; user_accepted: boolean; is_principal: boolean; company_accepted: boolean; company_accepted_by: string | null };

const doc = (slug: string, label: string) => <a href={`/${slug}/`} target="_blank" rel="noopener">{label}</a>;

export function LegalGate({ status, tenant, onDone }: { status: LegalStatus; tenant: any; onDone: (s: LegalStatus) => void }) {
  const needUser = !status.user_accepted;
  const needCompany = status.is_principal && !status.company_accepted;
  const [user, setUser] = useState(false);
  const [company, setCompany] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const coName = tenant?.brand_name || tenant?.name || "your company";
  const ready = (!needUser || user) && (!needCompany || company);
  async function accept(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErr("");
    try {
      const s = await db.rpc<LegalStatus>("accept_legal", { p_version: LEGAL_VERSION, p_tenant: tenant?.id || null, p_company: needCompany });
      onDone(s);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="center">
      <form className="card pad legal-gate" onSubmit={accept}>
        <img src={logoFor(tenant)} alt="" className="auth-logo-sm" />
        <h1>{status.user_accepted ? "Company agreement" : "Before you continue"}</h1>
        <p className="small muted" style={{ marginTop: 0 }}>
          {status.user_accepted
            ? "As a Principal, please accept the company agreement for " + coName + "."
            : "Please read and accept our terms. They were last updated on October 17, 2026."}
        </p>
        <ul className="legal-docs">
          {needUser && <>
            <li>{doc("terms", "Terms of Service")}</li>
            <li>{doc("privacy-policy", "Privacy Policy")}</li>
            <li>{doc("acceptable-use", "Acceptable Use Policy")}</li>
            <li>{doc("disclaimers", "Product and Professional Disclaimers")}</li>
          </>}
          {needCompany && <>
            <li>{doc("subscription-agreement", "Subscription Agreement")}</li>
            <li>{doc("dpa", "Data Processing Addendum")}</li>
          </>}
        </ul>
        {needUser && (
          <label className="check-row legal-check">
            <input type="checkbox" checked={user} onChange={(e) => setUser(e.target.checked)} />
            <span>I have read and agree to the Terms of Service, Privacy Policy, Acceptable Use Policy and Product and Professional Disclaimers, <b>including the agreement to resolve disputes by individual binding arbitration and the waiver of class actions and jury trials</b>. I understand the software does not give accounting, tax, legal, payroll or investment advice.</span>
          </label>
        )}
        {needCompany && (
          <label className="check-row legal-check">
            <input type="checkbox" checked={company} onChange={(e) => setCompany(e.target.checked)} />
            <span>I am authorized to bind <b>{coName}</b>, and I accept the Subscription Agreement and Data Processing Addendum on its behalf.</span>
          </label>
        )}
        {err && <div className="banner bad" style={{ margin: 0 }}><span>{err}</span></div>}
        <button className="btn pri wide" disabled={!ready || busy}>{busy ? "Saving…" : "Agree and continue"}</button>
        <button type="button" className="link" onClick={() => auth.signOut()}>I don't agree — sign out</button>
        <p className="fine">We record your acceptance with the date, time, version, IP address and browser.</p>
      </form>
    </div>
  );
}

/** Small notice for pages where a disclaimer matters; links to the matching section of the Disclaimers page. */
export function LegalNote({ children }: { children: React.ReactNode }) {
  return <p className="small muted disclaimer">{children} <a href="/disclaimers/" target="_blank" rel="noopener">Disclaimers</a></p>;
}

export function LegalLinks() {
  return (
    <div className="legal-links">
      <a href="/terms/" target="_blank" rel="noopener">Terms</a>
      <a href="/privacy-policy/" target="_blank" rel="noopener">Privacy</a>
      <a href="/disclaimers/" target="_blank" rel="noopener">Disclaimers</a>
      <a href="/legal/" target="_blank" rel="noopener">Legal</a>
    </div>
  );
}
