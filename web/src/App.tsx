import React, { useEffect, useMemo, useState } from "react";
import { auth, onAuth, currentSession, Session, mfa } from "./lib/sb";
import { SocialButtons, MfaGate, AccountSecurity } from "./security";
import { loadContext, makeCan, Ctx, Membership, Hotel, appName, productName, loadBranding, Branding, safeLogo, safeColor } from "./lib/app";
import { AlertsPanel, useAlerts } from "./pages/compliance";
import { Loading, ErrorBox } from "./ui";

// Each area of the app loads when first opened (smaller first download).
const page = <M extends Record<string, any>>(load: () => Promise<M>, name: keyof M) =>
  React.lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType<any> })));
const dashboards = () => import("./pages/dashboards"), admin = () => import("./pages/admin"), reports = () => import("./pages/reports");
const workforce = () => import("./pages/workforce"), finance = () => import("./pages/finance"), compliance = () => import("./pages/compliance");
const capital = () => import("./pages/capital"), intelligence = () => import("./pages/intelligence"), platform = () => import("./pages/platform");
const Portfolio = page(dashboards, "Portfolio"), HotelOverview = page(dashboards, "HotelOverview"), Str = page(dashboards, "Str");
const Hotels = page(admin, "Hotels"), Users = page(admin, "Users"), Company = page(admin, "Company"), Settings = page(admin, "Settings");
const Reports = page(reports, "Reports"), Snapshot = page(reports, "Snapshot");
const Schedule = page(workforce, "Schedule"), TimeClock = page(workforce, "TimeClock"), Timesheets = page(workforce, "Timesheets"), Team = page(workforce, "Team");
const Bills = page(finance, "Bills"), Vendors = page(finance, "Vendors"), Purchasing = page(finance, "Purchasing"), Banking = page(finance, "Banking"), Accounting = page(finance, "Accounting");
const Vault = page(compliance, "Vault"), Permits = page(compliance, "Permits"), Insurance = page(compliance, "Insurance");
const Investors = page(capital, "Investors"), InvestorPortal = page(capital, "InvestorPortal"), LoanPackage = page(capital, "LoanPackage"), PfsPage = page(capital, "PfsPage"), Construction = page(capital, "Construction");
const AskAI = page(intelligence, "AskAI"), PdfFiller = page(intelligence, "PdfFiller");
const PlatformCosts = page(platform, "PlatformCosts");
const Website = page(() => import("./pages/website"), "Website");
const Refunds = page(() => import("./pages/refunds"), "Refunds");

// ---------------- routing: #route/param ----------------
function useRoute() {
  const read = () => (window.location.hash.startsWith("#access_token") ? "" : window.location.hash.slice(1).split("?")[0]) || "portfolio";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r: string) => (window.location.hash = r)] as const;
}

// ---------------- sign-in screens ----------------
function AuthScreen({ recovery, onRecovered }: { recovery: boolean; onRecovered: () => void }) {
  const [brand, setBrand] = useState<Branding | null>(null);
  useEffect(() => {
    loadBranding().then((b) => {
      setBrand(b);
      const c = safeColor(b?.accent_color);
      if (c) document.documentElement.style.setProperty("--accent", c);
      document.title = b?.product_name || "Sign in";
    });
  }, []);
  const [mode, setMode] = useState<"in" | "up" | "reset" | "newpw" | "link">(recovery ? "newpw" : "in");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "info" | "bad"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "in") await auth.signIn(f.email, f.password);
      else if (mode === "up") {
        const r = await auth.signUp(f.email, f.password, f.name);
        if (r.needsConfirmation) setMsg({ kind: "info", text: `Check ${f.email} for a confirmation link, then sign in.` });
      } else if (mode === "link") {
        await auth.emailLink(f.email);
        setMsg({ kind: "info", text: `If ${f.email} has an account, a sign-in link is on its way. Open it on this device.` });
      } else if (mode === "reset") {
        await auth.resetPassword(f.email);
        setMsg({ kind: "info", text: `If ${f.email} has an account, a reset link is on its way.` });
      } else {
        await auth.updatePassword(f.password);
        onRecovered();
      }
    } catch (err: any) {
      setMsg({ kind: "bad", text: err.message === "Invalid login credentials" ? "That email and password don't match. Try again or reset your password." : err.message });
    } finally {
      setBusy(false);
    }
  }
  const title = { in: "Sign in", up: "Create your account", reset: "Reset your password", newpw: "Choose a new password", link: "Email me a sign-in link" }[mode];
  return (
    <div className="auth">
      <div className="auth-art" aria-hidden="true">
        <img src={safeLogo(brand?.logo_url)} alt="" className="auth-logo" />
        <p className="auth-quote">Every hotel, every number, one place.</p>
        <span className="auth-foot">{brand?.product_name || "Hotel operations"}</span>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <img src={safeLogo(brand?.logo_url)} alt={brand?.brand_name || brand?.name || ""} className="auth-logo-sm" />
        <h1>{title}</h1>
        {(mode === "in" || mode === "up") && <SocialButtons />}
        {mode === "up" && (
          <div className="field"><label htmlFor="aName">Full name</label>
            <input id="aName" required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        )}
        {mode !== "newpw" && (
          <div className="field"><label htmlFor="aEmail">Work email</label>
            <input id="aEmail" type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        )}
        {mode !== "reset" && mode !== "link" && (
          <div className="field"><label htmlFor="aPw">{mode === "newpw" ? "New password" : "Password"}</label>
            <input id="aPw" type="password" required minLength={mode === "in" ? 1 : 8} autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            {mode !== "in" && <span className="hint">At least 8 characters.</span>}</div>
        )}
        <button className="btn pri wide" disabled={busy}>{busy ? "Please wait…" : title}</button>
        {msg && <div className={"banner " + msg.kind} style={{ margin: 0 }}><span>{msg.text}</span></div>}
        <div className="auth-links">
          {mode === "in" && <><button type="button" className="link" onClick={() => setMode("reset")}>Forgot password?</button><button type="button" className="link" onClick={() => setMode("up")}>Create account</button></>}
          {(mode === "up" || mode === "reset" || mode === "link") && <button type="button" className="link" onClick={() => setMode("in")}>Back to sign in</button>}
        </div>
        <div className="auth-links" style={{ justifyContent: "center" }}>
          {mode === "in" && <button type="button" className="link" onClick={() => setMode("link")}>Sign in without a password</button>}
        </div>
        <p className="fine">New team members: use the email address your administrator invited.</p>
      </form>
    </div>
  );
}

// ---------------- navigation ----------------
type NavItem = { id: string; label: string; module: string; min?: "view" | "edit" | "approve" | "admin"; icon: string; show?: (ctx: Ctx) => boolean };
const I = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", bed: "M3 18V7M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6", target: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  spark: "M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z", inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5", mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  cal: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5", clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2", sheet: "M5 3h10l4 4v14H5zM9 12h6M9 16h6M9 8h2", people: "M9 8a3.5 3.5 0 1 0 0-.01M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5",
  bill: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6", bank: "M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18", ledger: "M4 19V5M4 19h16M8 15l3-4 3 2 5-6", store: "M4 8l2-4h12l2 4M4 8v12h16V8M4 8h16M9 20v-6h6v6", cart: "M3 4h2l2 11h11l2-8H6M9 20a1 1 0 1 0 0-.01M17 20a1 1 0 1 0 0-.01",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", badge: "M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8z", folder: "M3 6h6l2 2h10v11H3z", map: "M9 4l6 2 6-2v14l-6 2-6-2-6 2V6zM9 4v14M15 6v14",
  pie: "M12 3v9h9a9 9 0 1 1-9-9zM14 3.5A8 8 0 0 1 20.5 10H14z", zip: "M6 3h9l4 4v14H6zM10 3v2M10 7v2M10 11v2M10 15h2v3h-2z", user: "M12 8a4 4 0 1 0 0-.01M4 21a8 8 0 0 1 16 0", crane: "M4 21h16M6 21V5l8-2v4M6 5h14M18 5v6M17 11h2v3h-2zM10 21v-6h4v6",
  pdf: "M6 3h9l4 4v14H6zM9 13h2a1.5 1.5 0 0 0 0-3H9v6M14 10v6", hotel: "M5 3h14v18H5zM9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4", book: "M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 19V5", palette: "M12 3a9 9 0 1 0 0 18 3 3 0 0 1 0-6h2a7 7 0 0 0 7-7c0-2.8-4-5-9-5z",
};
const isInvestorOnly = (ctx: Ctx) => ctx.membership.roles.key === "investor";
const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Dashboards", items: [
    { id: "portfolio", label: "Portfolio Overview", module: "dashboards", icon: I.grid },
    { id: "hotel", label: "Hotel Overview", module: "dashboards", icon: I.bed },
    { id: "str", label: "STR Market", module: "str", icon: I.target },
    { id: "ask", label: "Ask AI", module: "ask_ai", icon: I.spark },
    { id: "investor-portal", label: "Investor Portal", module: "investor", icon: I.pie, show: (c) => isInvestorOnly(c) || c.can("investor", "admin") },
  ] },
  { group: "Reports", items: [
    { id: "reports", label: "Report Inbox", module: "reports", icon: I.inbox },
    { id: "snapshot", label: "Nightly Snapshot", module: "reports", icon: I.mail },
  ] },
  { group: "Workforce", items: [
    { id: "schedule", label: "Schedule", module: "workforce", icon: I.cal },
    { id: "timeclock", label: "Time Clock", module: "workforce", icon: I.clock },
    { id: "timesheets", label: "Timesheets & Payroll", module: "workforce", min: "edit", icon: I.sheet },
    { id: "team", label: "Team", module: "workforce", min: "edit", icon: I.people },
  ] },
  { group: "Finance", items: [
    { id: "bills", label: "Bills & Bill Pay", module: "finance", icon: I.bill },
    { id: "banking", label: "Banking & Reconciliation", module: "finance", icon: I.bank },
    { id: "accounting", label: "Accounting & Budget", module: "finance", icon: I.ledger },
    { id: "refunds", label: "Refunds", module: "finance", icon: I.bill },
    { id: "vendors", label: "Vendors", module: "finance", icon: I.store },
    { id: "purchasing", label: "Purchasing", module: "purchasing", icon: I.cart },
  ] },
  { group: "Compliance", items: [
    { id: "permits", label: "Permits & Licences", module: "compliance", icon: I.badge },
    { id: "insurance", label: "Insurance", module: "compliance", icon: I.shield },
    { id: "vault", label: "Document Vault", module: "compliance", icon: I.folder },
    { id: "plans", label: "Floor Plans", module: "compliance", icon: I.map },
  ] },
  { group: "Capital", items: [
    { id: "investors", label: "Investor Relations", module: "investor", min: "edit", icon: I.pie },
    { id: "loan", label: "Loan Package", module: "finance", min: "approve", icon: I.zip },
    { id: "pfs", label: "Personal Financial Statement", module: "company", min: "view", icon: I.user, show: (c) => c.membership.roles.requires_mfa },
    { id: "construction", label: "Construction", module: "construction", icon: I.crane },
  ] },
  { group: "Tools", items: [
    { id: "pdf", label: "PDF Form Filler", module: "dashboards", icon: I.pdf, show: (c) => c.can("dashboards") || c.can("finance") || c.can("compliance") },
  ] },
  { group: "Setup", items: [
    { id: "hotels", label: "Hotels", module: "dashboards", icon: I.hotel },
    { id: "company", label: "Company Information", module: "company", icon: I.book },
    { id: "users", label: "Users & Permissions", module: "users", icon: I.people },
    { id: "settings", label: "White-label Settings", module: "settings", icon: I.palette },
    { id: "website", label: "Website", module: "company", icon: I.mail, show: (c) => c.can("company") || c.can("workforce", "edit") },
    { id: "platform-costs", label: "Platform Costs", module: "platform_costs", icon: I.bill },
  ] },
];
const allowedItem = (ctx: Ctx, i: NavItem) => (i.show ? i.show(ctx) : ctx.can(i.module, i.min || "view"));

function Shell({ ctx, session }: { ctx: Ctx; session: Session }) {
  const [route, go] = useRoute();
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const alerts = useAlerts(ctx);
  const unread = (alerts.data || []).filter((n: any) => !n.read).length;
  const [page, param] = route.split("/");
  const t = ctx.tenant;
  useEffect(() => {
    if (safeColor(t.accent_color)) document.documentElement.style.setProperty("--accent", safeColor(t.accent_color)!);
    document.title = productName(t);
  }, [t.accent_color, t.brand_name, t.name, t.product_name]);
  useEffect(() => { setMenu(false); setBell(false); }, [route]);
  const items = NAV.flatMap((g) => g.items);
  const allowed = (id: string) => id === "account" || items.some((i) => i.id === id && allowedItem(ctx, i));
  const view = (() => {
    const p = allowed(page) ? page : items.find((i) => allowedItem(ctx, i))?.id;
    switch (p) {
      case "portfolio": return <Portfolio ctx={ctx} go={go} />;
      case "hotel": return <HotelOverview ctx={ctx} hotelId={param} go={go} />;
      case "str": return <Str ctx={ctx} hotelId={param} go={go} />;
      case "reports": return <Reports ctx={ctx} />;
      case "snapshot": return <Snapshot ctx={ctx} />;
      case "ask": return <AskAI ctx={ctx} />;
      case "investor-portal": return <InvestorPortal ctx={ctx} />;
      case "schedule": return <Schedule ctx={ctx} />;
      case "timeclock": return <TimeClock ctx={ctx} />;
      case "timesheets": return <Timesheets ctx={ctx} />;
      case "team": return <Team ctx={ctx} />;
      case "bills": return <Bills ctx={ctx} />;
      case "banking": return <Banking ctx={ctx} />;
      case "accounting": return <Accounting ctx={ctx} />;
      case "vendors": return <Vendors ctx={ctx} />;
      case "purchasing": return <Purchasing ctx={ctx} />;
      case "permits": return <Permits ctx={ctx} />;
      case "insurance": return <Insurance ctx={ctx} />;
      case "vault": return <Vault ctx={ctx} />;
      case "plans": return <Vault ctx={ctx} folder="floor_plans" key="plans" />;
      case "investors": return <Investors ctx={ctx} />;
      case "loan": return <LoanPackage ctx={ctx} />;
      case "pfs": return <PfsPage ctx={ctx} />;
      case "construction": return <Construction ctx={ctx} />;
      case "pdf": return <PdfFiller ctx={ctx} />;
      case "hotels": return <Hotels ctx={ctx} />;
      case "company": return <Company ctx={ctx} />;
      case "users": return <Users ctx={ctx} />;
      case "settings": return <Settings ctx={ctx} />;
      case "platform-costs": return <PlatformCosts ctx={ctx} />;
      case "website": return <Website ctx={ctx} />;
      case "refunds": return <Refunds ctx={ctx} />;
      case "account": return <AccountSecurity required={ctx.membership.roles.requires_mfa} email={session.user.email} />;
      default: return <div className="empty"><b>Your role doesn't include any {appName()} pages yet.</b><span>Ask your administrator to update your access.</span></div>;
    }
  })();
  return (
    <div className="app">
      <aside className={"rail" + (menu ? " open" : "")} aria-label="Main menu">
        <div className="brand">
          <img src={safeLogo(t.logo_url)} alt={t.brand_name || t.name} />
          <span className="sub">Operations Platform</span>
        </div>
        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => allowedItem(ctx, i));
            if (!items.length) return null;
            return (
              <React.Fragment key={g.group}>
                <div className="grp">{g.group}</div>
                {items.map((i) => (
                  <a key={i.id} href={"#" + i.id} className={page === i.id ? "on" : ""} aria-current={page === i.id ? "page" : undefined}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={i.icon} /></svg>
                    <span>{i.label}</span>
                  </a>
                ))}
              </React.Fragment>
            );
          })}
        </nav>
        <div className="rail-foot">
          <a className="me" href="#account" title="Sign-in & Security"><b>{session.user.email}</b><span>{ctx.membership.roles.name} · Security</span></a>
          <button className="btn sm" onClick={() => auth.signOut()}>Sign out</button>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className="main">
        <header className="top">
          <button className="btn sm menu" onClick={() => setMenu(true)} aria-label="Open menu">Menu</button>
          <span className="top-co">{t.brand_name || t.name}</span>
          <span className="spacer" />
          <button className="btn sm bell" onClick={() => { setBell(!bell); if (!bell) alerts.reload(); }} aria-label={`Alerts${unread ? `, ${unread} unread` : ""}`}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" /></svg>
            {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
          </button>
          <span className="top-role">{ctx.membership.roles.name}</span>
        </header>
        {bell && <AlertsPanel ctx={ctx} onClose={() => { setBell(false); alerts.reload(); }} />}
        <main className="content"><React.Suspense fallback={<Loading />}>{view}</React.Suspense></main>
      </div>
    </div>
  );
}

// ---------------- root ----------------
export default function App() {
  const [session, setSession] = useState<Session | null>(currentSession());
  const [recovery, setRecovery] = useState(false);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<{ membership: Membership | null; hotels: Hotel[] } | null>(null);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const [mfaState, setMfaState] = useState<"checking" | "needed" | "ok">("checking");

  useEffect(() => {
    auth.consumeRedirect().then((kind) => {
      if (kind === "recovery") setRecovery(true);
      setSession(currentSession());
      setReady(true);
    });
    return onAuth((s) => setSession(s)) as unknown as () => void;
  }, []);

  useEffect(() => {
    if (!session || recovery) { setData(null); return; }
    setErr("");
    loadContext().then(setData, (e) => setErr(e.message));
  }, [session?.user.id, recovery, tick]);

  // Two-step sign-in: required by role, or chosen by the user (has a verified authenticator).
  useEffect(() => { setMfaState("checking"); }, [session?.user.id]);
  useEffect(() => {
    if (!data?.membership) return;
    if (mfa.level() === "aal2") { setMfaState("ok"); return; }
    mfa.factors().then(
      (fs) => setMfaState(data.membership!.roles.requires_mfa || fs.some((f) => f.status === "verified") ? "needed" : "ok"),
      // couldn't check: don't let anyone past; show the error with a retry
      () => { setMfaState("checking"); setErr("Couldn't check your two-step sign-in. Check your connection and try again."); },
    );
  }, [data?.membership?.id, session?.access_token, tick]);

  const ctx: Ctx | null = useMemo(() => {
    if (!data?.membership) return null;
    return { membership: data.membership, tenant: data.membership.tenants, hotels: data.hotels, can: makeCan(data.membership), reload: () => setTick((x) => x + 1) };
  }, [data]);

  if (!ready) return <Loading />;
  if (!session || recovery) return <AuthScreen recovery={recovery} onRecovered={() => setRecovery(false)} />;
  if (err) return <div className="center"><ErrorBox error={err} retry={() => setTick((x) => x + 1)} /></div>;
  if (!data) return <Loading />;
  if (data.membership && mfaState === "checking") return <Loading />;
  if (data.membership && mfaState === "needed")
    return <MfaGate required={data.membership.roles.requires_mfa} email={session.user.email}
      onDone={() => { setMfaState(mfa.level() === "aal2" || !data.membership!.roles.requires_mfa ? "ok" : "needed"); setTick((x) => x + 1); }} />;
  if (!ctx)
    return (
      <div className="center">
        <div className="card pad">
          <h2>Your account isn't linked to a company yet</h2>
          <p>You're signed in as <b>{session.user.email}</b>. Ask your administrator to invite this email address, then sign in again.</p>
          <button className="btn" onClick={() => auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  return <Shell ctx={ctx} session={session} />;
}
