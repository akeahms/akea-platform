// Set or change the signed-in person's password under the company password policy:
//   at least 8 characters, an uppercase letter, a lowercase letter, a number and a special character,
//   and not a password this person has used before (compared against saved bcrypt hashes; plain passwords are never stored).
// Changing a password from a normal session needs the current password. Coming from an emailed reset or sign-in
// link (in the last hour) does not, because the email itself proved who they are.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";
const SB_URL = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");

export function problems(p: string): string[] {
  const out: string[] = [];
  if (p.length < 8) out.push("at least 8 characters");
  if (!/[A-Z]/.test(p)) out.push("an uppercase letter");
  if (!/[a-z]/.test(p)) out.push("a lowercase letter");
  if (!/[0-9]/.test(p)) out.push("a number");
  if (!/[^A-Za-z0-9]/.test(p)) out.push("a special character");
  return out;
}

function claims(token: string): Record<string, any> {
  try {
    const p = token.split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

async function rpc(name: string, args: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`Check failed (${r.status})`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const auth = req.headers.get("Authorization") || "";
  const who = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!who.ok) return json({ error: "Your link or sign-in has expired. Please sign in again." }, 401);
  const user = await who.json();
  const body = await req.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";
  const current = typeof body.current === "string" ? body.current : "";

  const missing = problems(password);
  if (password.length > 72) return json({ error: "Use 72 characters or fewer." }, 400);
  if (missing.length) return json({ error: `Your password needs ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`, missing }, 400);

  // emailed reset / sign-in link in the last hour proves who they are; otherwise ask for the current password
  const amr: { method: string; timestamp: number }[] = claims(auth.replace(/^Bearer\s+/i, "")).amr || [];
  const latest = [...amr].sort((a, b) => b.timestamp - a.timestamp)[0];
  const viaEmail = latest && ["recovery", "otp", "magiclink", "invite", "email/signup"].includes(latest.method) && Date.now() / 1000 - latest.timestamp < 3600;
  if (!viaEmail) {
    if (!current) return json({ error: "Enter your current password.", needCurrent: true }, 400);
    const ok = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: current }),
    });
    if (!ok.ok) return json({ error: "Your current password isn't right.", needCurrent: true }, 400);
  }

  if (await rpc("password_was_used", { p_user: user.id, p_password: password })) {
    return json({ error: "You've used that password before. Choose one you haven't used." }, 400);
  }

  const upd = await fetch(`${SB_URL}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!upd.ok) {
    const t = await upd.text();
    let msg = "Couldn't save the new password. Try again.";
    try { const j = JSON.parse(t); msg = j.msg || j.message || j.error_description || msg; } catch { /* keep default */ }
    return json({ error: msg }, 400);
  }
  return json({ ok: true });
});
