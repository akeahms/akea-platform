// Verifies that a webhook really came from Plaid: the Plaid-Verification header is an ES256-signed JWT whose
// payload carries the SHA-256 of the request body. Keys come from /webhook_verification_key/get and are cached.
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sameText = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export type GetKey = (kid: string) => Promise<{ kty: string; crv: string; x: string; y: string; expired_at?: number | null } | null>;

export async function verifyPlaidWebhook(body: string, jwt: string | null, getKey: GetKey, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  try {
    if (!jwt) return false;
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return false;
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    if (header.alg !== "ES256" || !header.kid) return false;
    const jwk = await getKey(header.kid);
    if (!jwk || (jwk.expired_at && jwk.expired_at < nowSec)) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (!payload.iat || Math.abs(nowSec - Number(payload.iat)) > 5 * 60) return false;              // older than 5 minutes: replay
    const digest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
    return sameText(digest, String(payload.request_body_sha256 || ""));
  } catch {
    return false;
  }
}
