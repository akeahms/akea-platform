import React, { useEffect, useMemo, useState } from "react";
import { auth, onAuth, currentSession, Session } from "./lib/sb";
import { loadContext, makeCan, Ctx, Membership, Hotel } from "./lib/app";
import { Portfolio, HotelOverview, Str } from "./pages/dashboards";
import { Reports, Hotels, Users, Company, Settings } from "./pages/admin";
import { Loading, ErrorBox } from "./ui";

// ---------------- routing: #route/param ----------------
function useRoute() {
  const read = () => (window.location.hash.startsWith("#access_token") ? "" : window.location.hash.slice(1)) || "portfolio";
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
  const [mode, setMode] = useState<"in" | "up" | "reset" | "newpw">(recovery ? "newpw" : "in");
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
  const title = { in: "Sign in", up: "Create your account", reset: "Reset your password", newpw: "Choose a new password" }[mode];
  return (
    <div className="auth">
      <div className="auth-art" aria-hidden="true">
        <img src="/logo.png" alt="" className="auth-logo" />
        <p className="auth-quote">Every hotel, every number, one place.</p>
        <span className="auth-foot">Hotel Operations Platform</span>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <img src="/logo.png" alt="Akea Hotel Management Services" className="auth-logo-sm" />
        <h1>{title}</h1>
        {mode === "up" && (
          <div className="field"><label htmlFor="aName">Full name</label>
            <input id="aName" required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        )}
        {mode !== "newpw" && (
          <div className="field"><label htmlFor="aEmail">Work email</label>
            <input id="aEmail" type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        )}
        {mode !== "reset" && (
          <div className="field"><label htmlFor="aPw">{mode === "newpw" ? "New password" : "Password"}</label>
            <input id="aPw" type="password" required minLength={mode === "in" ? 1 : 10} autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            {mode !== "in" && <span className="hint">At least 10 characters.</span>}</div>
        )}
        <button className="btn pri wide" disabled={busy}>{busy ? "Please wait…" : title}</button>
        {msg && <div className={"banner " + msg.kind} style={{ margin: 0 }}><span>{msg.text}</span></div>}
        <div className="auth-links">
          {mode === "in" && <><button type="button" className="link" onClick={() => setMode("reset")}>Forgot password?</button><button type="button" className="link" onClick={() => setMode("up")}>Create account</button></>}
          {(mode === "up" || mode === "reset") && <button type="button" className="link" onClick={() => setMode("in")}>Back to sign in</button>}
        </div>
        <p className="fine">New team members: use the email address your administrator invited.</p>
      </form>
    </div>
  );
}

// ---------------- navigation ----------------
const NAV: { group: string; items: { id: string; label: string; module: string; icon: string }[] }[] = [
  { group: "Dashboards", items: [
    { id: "portfolio", label: "Portfolio Overview", module: "dashboards", icon: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
    { id: "hotel", label: "Hotel Overview", module: "dashboards", icon: "M3 18V7M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6" },
    { id: "str", label: "STR Market", module: "str", icon: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  ] },
  { group: "Data", items: [
    { id: "reports", label: "Report Inbox", module: "reports", icon: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5" },
  ] },
  { group: "Setup", items: [
    { id: "hotels", label: "Hotels", module: "dashboards", icon: "M5 3h14v18H5zM9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4" },
    { id: "company", label: "Company Information", module: "company", icon: "M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 19V5" },
    { id: "users", label: "Users & Permissions", module: "users", icon: "M9 8a3.5 3.5 0 1 0 0-.01M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5" },
    { id: "settings", label: "White-label Settings", module: "settings", icon: "M12 3a9 9 0 1 0 0 18 3 3 0 0 1 0-6h2a7 7 0 0 0 7-7c0-2.8-4-5-9-5z" },
  ] },
];

function Shell({ ctx, session }: { ctx: Ctx; session: Session }) {
  const [route, go] = useRoute();
  const [menu, setMenu] = useState(false);
  const [page, param] = route.split("/");
  const t = ctx.tenant;
  useEffect(() => {
    if (t.accent_color) document.documentElement.style.setProperty("--accent", t.accent_color);
    document.title = `${t.brand_name || t.name} · Portal`;
  }, [t.accent_color, t.brand_name, t.name]);
  useEffect(() => setMenu(false), [route]);
  const allowed = (id: string) => NAV.flatMap((g) => g.items).some((i) => i.id === id && ctx.can(i.module));
  const view = (() => {
    const p = allowed(page) ? page : NAV.flatMap((g) => g.items).find((i) => ctx.can(i.module))?.id;
    switch (p) {
      case "portfolio": return <Portfolio ctx={ctx} go={go} />;
      case "hotel": return <HotelOverview ctx={ctx} hotelId={param} go={go} />;
      case "str": return <Str ctx={ctx} hotelId={param} go={go} />;
      case "reports": return <Reports ctx={ctx} />;
      case "hotels": return <Hotels ctx={ctx} />;
      case "company": return <Company ctx={ctx} />;
      case "users": return <Users ctx={ctx} />;
      case "settings": return <Settings ctx={ctx} />;
      default: return <div className="empty"><b>Your role doesn't include any portal pages yet.</b><span>Ask your administrator to update your access.</span></div>;
    }
  })();
  return (
    <div className="app">
      <aside className={"rail" + (menu ? " open" : "")} aria-label="Main menu">
        <div className="brand">
          <img src={t.logo_url || "/logo.png"} alt={t.brand_name || t.name} />
          <span className="sub">Operations Platform</span>
        </div>
        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => ctx.can(i.module));
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
          <div className="me"><b>{session.user.email}</b><span>{ctx.membership.roles.name}</span></div>
          <button className="btn sm" onClick={() => auth.signOut()}>Sign out</button>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className="main">
        <header className="top">
          <button className="btn sm menu" onClick={() => setMenu(true)} aria-label="Open menu">Menu</button>
          <span className="top-co">{t.brand_name || t.name}</span>
          <span className="spacer" />
          <span className="top-role">{ctx.membership.roles.name}</span>
        </header>
        <main className="content">{view}</main>
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

  const ctx: Ctx | null = useMemo(() => {
    if (!data?.membership) return null;
    return { membership: data.membership, tenant: data.membership.tenants, hotels: data.hotels, can: makeCan(data.membership), reload: () => setTick((x) => x + 1) };
  }, [data]);

  if (!ready) return <Loading />;
  if (!session || recovery) return <AuthScreen recovery={recovery} onRecovered={() => setRecovery(false)} />;
  if (err) return <div className="center"><ErrorBox error={err} retry={() => setTick((x) => x + 1)} /></div>;
  if (!data) return <Loading />;
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
