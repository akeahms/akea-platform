// Minimal .eml (MIME) reader for the browser: headers, nested multiparts, base64 / quoted-printable, attachment names.
export type EmlPart = { filename: string | null; type: string; bytes: Uint8Array };
export type Eml = { subject: string; from: string; to: string; date: string; parts: EmlPart[] };

const dec = new TextDecoder("utf-8");
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

function decodeWords(s: string) {
  // =?utf-8?B?...?= and =?utf-8?Q?...?=
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === "B") return dec.decode(Uint8Array.from(atob(txt), (c) => c.charCodeAt(0)));
      return dec.decode(qp(txt.replace(/_/g, " ")));
    } catch { return txt; }
  });
}
function qp(s: string): Uint8Array {
  const out: number[] = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 255);
  }
  return new Uint8Array(out);
}
function headers(block: string) {
  const h: Record<string, string> = {};
  block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach((l) => {
    const i = l.indexOf(":");
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  });
  return h;
}
const param = (v: string | undefined, name: string) => {
  if (!v) return null;
  const star = v.match(new RegExp(`${name}\\*=(?:[^']*'[^']*')?([^;]+)`, "i"));
  if (star) { try { return decodeURIComponent(star[1].replace(/"/g, "")); } catch { return star[1]; } }
  const m = v.match(new RegExp(`${name}="?([^";]+)"?`, "i"));
  return m ? decodeWords(m[1]) : null;
};

function walk(raw: string, out: EmlPart[]) {
  const split = raw.search(/\r?\n\r?\n/);
  const h = headers(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const ct = h["content-type"] || "text/plain";
  const boundary = param(ct, "boundary");
  if (/^multipart\//i.test(ct) && boundary) {
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*\\r?\\n?`));
    parts.slice(1).forEach((p) => p.trim() && walk(p, out));
    return h;
  }
  const enc = (h["content-transfer-encoding"] || "").toLowerCase();
  let bytes: Uint8Array;
  if (enc === "base64") bytes = Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0));
  else if (enc === "quoted-printable") bytes = qp(body);
  else bytes = Uint8Array.from(body, (c) => c.charCodeAt(0) & 255);
  out.push({ filename: param(h["content-disposition"], "filename") || param(ct, "name"), type: ct.split(";")[0].trim().toLowerCase(), bytes });
  return h;
}

export async function readEml(file: Blob): Promise<Eml> {
  const raw = latin1(new Uint8Array(await file.arrayBuffer()));
  const parts: EmlPart[] = [];
  const h = walk(raw, parts);
  return { subject: decodeWords(h["subject"] || ""), from: decodeWords(h["from"] || ""), to: decodeWords(h["to"] || ""), date: h["date"] || "", parts };
}
