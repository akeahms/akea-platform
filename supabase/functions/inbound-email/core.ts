// Pure text helpers shared by the web app and the inbound-email server function (no browser APIs here).
// ---------------- primitives ----------------
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

/** Parses most US statement date styles; `yearHint` fills in MM/DD dates. */
export function parseDate(s: string, yearHint?: number): string | null {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})/); // OFX 20261015120000
  if (m && +m[2] <= 12) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? +m[3] : yearHint || new Date().getFullYear();
    if (y < 100) y += 2000;
    if (+m[1] > 12) return null;
    return `${y}-${pad(+m[1])}-${pad(+m[2])}`;
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/);   // Oct 1, October 1st 2026, Sept 9
  const mon = (w: string) => MONTHS[w.toLowerCase().slice(0, 3)] && (w.length <= 4 || "january february march april may june july august september october november december".includes(w.toLowerCase())) ? MONTHS[w.toLowerCase().slice(0, 3)] : 0;
  if (m && mon(m[1])) return `${m[3] || yearHint || new Date().getFullYear()}-${pad(mon(m[1]))}-${pad(+m[2])}`;
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[a-z]*[\s\-,]*(\d{2,4})?$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = m[3] ? +m[3] : yearHint || new Date().getFullYear();
    if (y < 100) y += 2000;
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`;
  }
  // Excel serial date
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((+s - 25569) * 864e5));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return null;
}

/** "$1,234.56", "(1,234.56)", "1,234.56-", "1234.56 CR", "-12" → number */
export function parseAmount(s: unknown): number | null {
  if (typeof s === "number") return isFinite(s) ? s : null;
  if (s == null) return null;
  let t = String(s).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  if (/\bDR\b|\bDB\b/i.test(t)) neg = true;
  t = t.replace(/\b(CR|DR|DB|USD)\b/gi, "").replace(/[$,\s]/g, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = parseFloat(t);
  return neg ? -v : v;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const delim = (() => {
    const first = text.split(/\r?\n/, 5).join("\n");
    const counts = [",", "\t", ";", "|"].map((d) => [d, first.split(d).length] as const);
    return counts.sort((a, b) => b[1] - a[1])[0][0];
  })();
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

