import { appName, currentLogo } from "./lib/app";
import React, { useEffect, useState } from "react";
import { auth, mfa, Factor } from "./lib/sb";
import { Card, PageHead, Pill, Loading, ErrorBox, Empty } from "./ui";

// ---------------- social sign-in buttons (only providers switched on in Supabase) ----------------
const PROVIDERS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: "google", label: "Google", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h6c-.3 1.4-1 2.6-2.2 3.4v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.9C3.8 20.6 7.6 23 12 23z"/><path fill="#FBBC05" d="M5.7 14c-.2-.7-.4-1.3-.4-2s.1-1.4.4-2V7.1H2C1.4 8.6 1 10.2 1 12s.4 3.4 1 4.9L5.7 14z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2C17.5 2.1 15 1 12 1 7.6 1 3.8 3.4 2 7.1L5.7 10c.9-2.6 3.4-4.6 6.3-4.6z"/></svg> },
  { key: "azure", label: "Microsoft", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg> },
  { key: "apple", label: "Apple", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.1 1.1.1 2.3-.6 3-1.5z"/></svg> },
  { key: "linkedin_oidc", label: "LinkedIn", icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0A66C2" d="M20.4 2H3.6C2.7 2 2 2.7 2 3.6v16.8c0 .9.7 1.6 1.6 1.6h16.8c.9 0 1.6-.7 1.6-1.6V3.6c0-.9-.7-1.6-1.6-1.6zM8 19H5V9.5h3V19zM6.5 8.2c-1 0-1.7-.8-1.7-1.7s.8-1.7 1.7-1.7 1.7.8 1.7 1.7-.7 1.7-1.7 1.7zM19 19h-3v-4.6c0-1.1 0-2.5-1.5-2.5s-1.8 1.2-1.8 2.4V19h-3V9.5h2.9v1.3c.4-.8 1.4-1.5 2.9-1.5 3.1 0 3.6 2 3.6 4.7V19z"/></svg> },
];

export function SocialButtons() {
  const [enabled, setEnabled] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    auth.providers().then(setEnabled);
  }, []);
  const list = PROVIDERS.filter((p) => enabled?.[p.key]);
  if (!list.length) return null;
  return (
    <>
      <div className="social">
        {list.map((p) => (
          <a key={p.key} className="btn social-btn" href={auth.oauthUrl(p.key)}>
            {p.icon}
            <span>Continue with {p.label}</span>
          </a>
        ))}
      </div>
      <div className="or"><span>or</span></div>
    </>
  );
}

// ---------------- two-factor step after sign-in ----------------
export function MfaGate({ required, email, onDone }: { required: boolean; email: string; onDone: () => void }) {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    mfa.factors().then(async (fs) => {
      setFactors(fs);
      const verified = fs.filter((f) => f.status === "verified");
      if (!verified.length) {
        // Remove abandoned unverified enrollments, then start a fresh one.
        for (const f of fs.filter((x) => x.status !== "verified")) await mfa.remove(f.id).catch(() => {});
        setEnroll(await mfa.enroll(`Authenticator ${new Date().toLocaleDateString("en-US")}`));
      }
    }, (e) => setErr(e.message));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const id = enroll ? enroll.id : factors!.find((f) => f.status === "verified")!.id;
      await mfa.verify(id, code.replace(/\s/g, ""));
      onDone();
    } catch (e: any) {
      setErr(e.message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card pad mfa" onSubmit={submit}>
        <img src={currentLogo()} alt="" className="auth-logo-sm" style={{ display: "block" }} />
        {!factors && !err && <Loading />}
        {enroll && (
          <>
            <h2>Set up two-step sign-in</h2>
            <p>{required ? "Your role handles sensitive information, so a second step is required." : "Add a second step to protect your account."} Scan this code with an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy.</p>
            <img src={enroll.qr} alt="QR code for your authenticator app" className="qr" />
            <details>
              <summary>Can't scan? Enter this key instead</summary>
              <code className="secret">{enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              <span className="small muted">In your authenticator app choose "Enter a setup key", name it {appName()}, and type this key. Then enter the 6-digit number the app shows below.</span>
            </details>
          </>
        )}
        {factors && !enroll && (
          <>
            <h2>Enter your sign-in code</h2>
            <p>Open your authenticator app and enter the 6-digit code for <b>{appName()}</b> ({email}).</p>
          </>
        )}
        {(enroll || (factors && !enroll)) && (
          <>
            <div className="field">
              <label htmlFor="mfaCode">6-digit code</label>
              <input id="mfaCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required autoFocus placeholder="123456"
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="code-input" />
            </div>
            <button className="btn pri wide" disabled={busy}>{busy ? "Checking…" : enroll ? "Turn on and continue" : "Verify"}</button>
          </>
        )}
        {err && <div className="banner bad" style={{ margin: 0 }}><span>{err}</span></div>}
        <div className="auth-links">
          {!required && enroll && <button type="button" className="link" onClick={onDone}>Not now</button>}
          <button type="button" className="link" onClick={() => auth.signOut()}>Sign out</button>
        </div>
      </form>
    </div>
  );
}

// ---------------- My account: sign-in security ----------------
// ---------------- password rules (the server checks the same rules, plus that the password hasn't been used before) ----------------
export const PASSWORD_RULES: { label: string; ok: (p: string) => boolean }[] = [
  { label: "At least 8 characters", ok: (p) => p.length >= 8 },
  { label: "1 uppercase letter", ok: (p) => /[A-Z]/.test(p) },
  { label: "1 lowercase letter", ok: (p) => /[a-z]/.test(p) },
  { label: "1 number", ok: (p) => /[0-9]/.test(p) },
  { label: "1 special character", ok: (p) => /[^A-Za-z0-9]/.test(p) },
];
export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.ok(p));

export function PasswordRules({ value }: { value: string }) {
  return (
    <ul className="pwrules" aria-label="Password rules">
      {PASSWORD_RULES.map((r) => {
        const ok = r.ok(value);
        return <li key={r.label} className={ok ? "ok" : ""}><span aria-hidden="true">{ok ? "✓" : "•"}</span>{r.label}{ok ? <span className="sr-only"> (done)</span> : null}</li>;
      })}
      <li className="note">Can't be a password you've used before</li>
    </ul>
  );
}

function ChangePassword() {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!passwordOk(f.next)) { setMsg({ kind: "bad", text: "The new password doesn't meet every rule yet." }); return; }
    if (f.next !== f.again) { setMsg({ kind: "bad", text: "The two new passwords don't match." }); return; }
    setBusy(true);
    try {
      await auth.updatePassword(f.next, f.current);
      setF({ current: "", next: "", again: "" });
      setMsg({ kind: "good", text: "Password changed." });
    } catch (err: any) {
      setMsg({ kind: "bad", text: err.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Password">
      <form onSubmit={submit} className="stack">
        <div className="field"><label htmlFor="pwCur">Current password</label>
          <input id="pwCur" type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></div>
        <div className="field"><label htmlFor="pwNew">New password</label>
          <input id="pwNew" type="password" autoComplete="new-password" required maxLength={72} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
          <PasswordRules value={f.next} /></div>
        <div className="field"><label htmlFor="pwAgain">New password again</label>
          <input id="pwAgain" type="password" autoComplete="new-password" required maxLength={72} value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></div>
        <div><button className="btn pri" disabled={busy}>{busy ? "Saving…" : "Change password"}</button></div>
        {msg && <div className={"banner " + msg.kind} style={{ margin: 0 }}><span>{msg.text}</span></div>}
        <p className="small muted" style={{ margin: 0 }}>Signed in with Google, Microsoft or a sign-in link and never set a password? Use "Forgot password?" on the sign-in page to set one.</p>
      </form>
    </Card>
  );
}

export function AccountSecurity({ required, email }: { required: boolean; email: string }) {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [err, setErr] = useState("");
  const [setup, setSetup] = useState(false);
  const load = () => mfa.factors().then(setFactors, (e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const verified = (factors || []).filter((f) => f.status === "verified");
  if (setup) return <MfaGate required={false} email={email} onDone={() => { setSetup(false); load(); }} />;
  return (
    <>
      <PageHead eyebrow="My account" title="Sign-in & Security" desc={`Signed in as ${email}.`} />
      {err && <ErrorBox error={err} />}
      {!factors && !err && <Loading />}
      {factors && (
        <div className="grid g2">
          <Card title="Two-step sign-in" note={verified.length ? <Pill kind="good">On</Pill> : <Pill kind={required ? "bad" : "mute"}>Off</Pill>}>
            <p className="small" style={{ marginTop: 0 }}>
              After your password, you enter a 6-digit code from an authenticator app.{required ? " Your role requires it." : ""}
            </p>
            {verified.length ? (
              <div className="list">
                {verified.map((f) => (
                  <div className="li" key={f.id} style={{ padding: "10px 0" }}>
                    <div><div className="t">{f.friendly_name || "Authenticator app"}</div><div className="s">Authenticator app</div></div>
                    {!required && verified.length > 0 && (
                      <div className="r"><button className="btn sm" onClick={async () => { await mfa.remove(f.id).catch((e) => setErr(e.message)); load(); }}>Remove</button></div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <button className="btn pri" onClick={() => setSetup(true)}>Set up two-step sign-in</button>
            )}
          </Card>
          <Card title="Ways to sign in">
            <ul className="plain">
              <li>Email and password</li>
              <li>One-time sign-in link sent to your email</li>
              <li>Google, Microsoft, Apple or LinkedIn, when your administrator has switched them on</li>
            </ul>
            <p className="small muted">Use the same email address everywhere so every method opens the same account.</p>
          </Card>
          <ChangePassword />
        </div>
      )}
      {factors && !factors.length && !required && <Empty title="Tip: turn on two-step sign-in to protect your account." />}
    </>
  );
}
