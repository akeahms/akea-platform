// Fast, in-browser reading of bank statements, reports and invoices.
// Text formats (CSV, OFX/QFX, BAI2, TXT, XML) and Excel are read directly; digital PDFs via pdf.js text.
// Nothing leaves the browser until the cleaned rows are saved.

export type BankRow = { date: string; amount: number; description: string; ref?: string; kind?: string; external_id?: string };
export type BankParse = { format: string; rows: BankRow[]; from?: string; to?: string; opening?: number; closing?: number; warnings: string[]; ms: number };

import { parseDate, parseAmount, parseCsv } from "./core";
export { parseDate, parseAmount, parseCsv };

// ---------------- Excel (.xlsx) without a heavy library: unzip + read the sheet XML ----------------
export async function readXlsx(file: Blob): Promise<string[][][]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);
  const xml = (p: string) => zip.file(p)?.async("string");
  const parser = new DOMParser();
  const shared: string[] = [];
  const ss = await xml("xl/sharedStrings.xml");
  if (ss) {
    const d = parser.parseFromString(ss, "application/xml");
    Array.from(d.getElementsByTagName("si")).forEach((si) => shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent || "").join("")));
  }
  const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]));
  const sheets: string[][][] = [];
  for (const n of names) {
    const d = parser.parseFromString((await xml(n))!, "application/xml");
    const out: string[][] = [];
    Array.from(d.getElementsByTagName("row")).forEach((r) => {
      const cells: string[] = [];
      Array.from(r.getElementsByTagName("c")).forEach((c) => {
        const ref = c.getAttribute("r") || "";
        const col = ref.replace(/\d+/g, "").split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const t = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        const isv = c.getElementsByTagName("is")[0];
        let val = t === "s" ? shared[+v] ?? "" : t === "inlineStr" ? (isv?.textContent ?? "") : v;
        // style-less dates arrive as serials; leave numeric, parseDate handles serials
        cells[col >= 0 ? col : cells.length] = val;
      });
      out.push(Array.from(cells, (x) => (x ?? "").trim()));
    });
    sheets.push(out.filter((r) => r.some((x) => x !== "")));
  }
  return sheets;
}

// ---------------- PDF text (digital PDFs; scanned images need OCR) ----------------
export async function pdfLines(file: Blob): Promise<string[]> {
  const pdfjs: any = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // group text items into lines by their y position, then order by x
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as any[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 2.5) * 2.5;
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2.5) ?? y;
      rows.set(key, [...(rows.get(key) || []), { x: it.transform[4], s: it.str }]);
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
      const sorted = items.sort((a, b) => a.x - b.x);
      let line = "", lastX = -1e9;
      for (const it of sorted) { line += (line && it.x - lastX > 4 ? "  " : line ? " " : "") + it.s; lastX = it.x + it.s.length * 4.5; }
      lines.push(line.replace(/\s{3,}/g, "  ").trim());
    });
  }
  return lines;
}

// ---------------- table → bank rows (CSV / Excel / any columnar export) ----------------
const H = {
  date: /^(post(ed|ing)?\s*)?date$|^trans(action)?\.?\s*date$|^date\s*posted$|^effective\s*date$|^value\s*date$/i,
  desc: /desc|memo|payee|narrative|details|transaction$|^name$|particulars/i,
  amount: /^amount$|^amt$|transaction\s*amount|^net\s*amount$/i,
  debit: /debit|withdraw|payment|money\s*out|charges?$|^dr$/i,
  credit: /credit|deposit|money\s*in|receipts?$|^cr$/i,
  ref: /check\s*(no|number|#)|^ref|reference|serial|^chk/i,
  balance: /balance/i,
  type: /^type$|trans(action)?\s*type|dr\/cr|^cr\/dr$/i,
};
export function bankRowsFromTable(table: string[][]): { rows: BankRow[]; warnings: string[]; closing?: number } {
  const warnings: string[] = [];
  let hi = -1, col: Record<string, number> = {};
  for (let i = 0; i < Math.min(table.length, 40); i++) {
    const r = table[i].map((x) => x.toLowerCase());
    const c: Record<string, number> = {};
    r.forEach((h, j) => {
      for (const [k, re] of Object.entries(H)) if (c[k] === undefined && re.test(h)) { c[k] = j; break; }
    });
    if (c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined)) { hi = i; col = c; break; }
  }
  if (hi < 0) {
    // headerless: guess date + amount columns from the data
    const sample = table.slice(0, 20);
    const ncol = Math.max(...sample.map((r) => r.length));
    const score = (j: number, f: (s: string) => boolean) => sample.filter((r) => r[j] && f(r[j])).length;
    for (let j = 0; j < ncol; j++) {
      if (col.date === undefined && score(j, (s) => !!parseDate(s)) > sample.length * 0.6) col.date = j;
      else if (col.amount === undefined && score(j, (s) => parseAmount(s) !== null && /\d\.\d{2}/.test(s)) > sample.length * 0.6) col.amount = j;
      else if (col.desc === undefined && score(j, (s) => /[a-z]{3}/i.test(s)) > sample.length * 0.6) col.desc = j;
    }
    if (col.date === undefined || col.amount === undefined) return { rows: [], warnings: ["Couldn't find date and amount columns."] };
    warnings.push("No header row found; columns were detected from the data.");
  }
  const rows: BankRow[] = [];
  let closing: number | undefined;
  for (const r of table.slice(hi + 1)) {
    const date = parseDate(r[col.date]);
    if (!date) continue;
    let amount: number | null = null;
    if (col.amount !== undefined) {
      amount = parseAmount(r[col.amount]);
      if (amount !== null && col.type !== undefined && /^(d|dr|debit|withdrawal)/i.test(r[col.type] || "")) amount = -Math.abs(amount);
    } else {
      const d = parseAmount(r[col.debit]), c = parseAmount(r[col.credit]);
      if (d) amount = -Math.abs(d);
      else if (c) amount = Math.abs(c);
    }
    if (amount === null || amount === 0) continue;
    const desc = col.desc !== undefined ? r[col.desc] : r.filter((x, j) => j !== col.date && parseAmount(x) === null).join(" ");
    rows.push({ date, amount: Math.round(amount * 100) / 100, description: desc || "", ref: col.ref !== undefined ? r[col.ref] || undefined : undefined });
    if (col.balance !== undefined) { const b = parseAmount(r[col.balance]); if (b !== null) closing = b; }
  }
  return { rows, warnings, closing };
}

// ---------------- OFX / QFX ----------------
export function parseOfx(text: string): Omit<BankParse, "ms" | "format"> {
  const tag = (block: string, t: string) => block.match(new RegExp(`<${t}>([^<\\r\\n]*)`, "i"))?.[1]?.trim();
  const rows: BankRow[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const b0 of blocks) {
    const b = b0.split(/<\/STMTTRN>/i)[0];
    const date = parseDate(tag(b, "DTPOSTED") || "");
    const amount = parseAmount(tag(b, "TRNAMT"));
    if (!date || amount === null) continue;
    const name = tag(b, "NAME") || "", memo = tag(b, "MEMO") || "";
    rows.push({ date, amount, description: [name, memo].filter(Boolean).join(" · ").replace(/&amp;/g, "&"),
      ref: tag(b, "CHECKNUM") || tag(b, "REFNUM") || undefined, kind: (tag(b, "TRNTYPE") || "").toLowerCase() || undefined, external_id: tag(b, "FITID") || undefined });
  }
  const ledger = text.split(/<LEDGERBAL>/i)[1] || "";
  return { rows, from: parseDate(tag(text, "DTSTART") || "") || undefined, to: parseDate(tag(text, "DTEND") || "") || undefined,
    closing: parseAmount(tag(ledger, "BALAMT")) ?? undefined, warnings: [] };
}

// ---------------- BAI2 (bank cash-management files) ----------------
export function parseBai2(text: string): Omit<BankParse, "ms" | "format"> {
  // join continuation records (88) onto the previous record
  const recs: string[] = [];
  text.split(/\r?\n/).forEach((l) => {
    l = l.trim().replace(/\/$/, "");
    if (!l) return;
    if (l.startsWith("88,") && recs.length) recs[recs.length - 1] += "," + l.slice(3);
    else recs.push(l);
  });
  const rows: BankRow[] = [];
  let asOf: string | undefined, opening: number | undefined, closing: number | undefined;
  for (const r of recs) {
    const f = r.split(",");
    if (f[0] === "02") { const d = f[4]; if (d) asOf = parseDate(`20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`) || asOf; }
    if (f[0] === "03") {
      for (let i = 3; i + 1 < f.length; i += 4) {
        if (f[i] === "010" || f[i] === "040") opening = +f[i + 1] / 100;
        if (f[i] === "015" || f[i] === "045") closing = +f[i + 1] / 100;
      }
    }
    if (f[0] === "16") {
      const code = +f[1], cents = +f[2];
      if (!cents || !asOf) continue;
      // funds-type S/V/D carry extra fields before the bank reference
      let i = 4;
      if (f[3] === "S") i += 3; else if (f[3] === "V") i += 2; else if (f[3] === "D") i += 1 + 2 * (+f[4] || 0);
      const bankRef = f[i], custRef = f[i + 1], txt = f.slice(i + 2).join(",").trim();
      const credit = code >= 100 && code < 400;
      rows.push({ date: asOf, amount: (credit ? 1 : -1) * cents / 100, description: txt || `BAI type ${code}`, ref: custRef || bankRef || undefined,
        kind: credit ? "deposit" : "withdrawal", external_id: bankRef ? `bai-${asOf}-${bankRef}-${cents}` : undefined });
    }
  }
  const dates = rows.map((r) => r.date).sort();
  return { rows, from: dates[0], to: dates[dates.length - 1], opening, closing, warnings: [] };
}

// ---------------- PDF statements ----------------
// Works on the text layer: lines that start with a date and end in amounts. The running balance
// (when the bank prints one) decides deposit vs withdrawal; otherwise section headings do.
export function bankRowsFromPdf(lines: string[]): { rows: BankRow[]; warnings: string[]; opening?: number; closing?: number; from?: string; to?: string } {
  const warnings: string[] = [];
  const all = lines.join("\n");
  const yearM = all.match(/(?:statement\s+period|through|thru|ending|period)[^\n]*?(\d{1,2}\/\d{1,2}\/(\d{2,4}))/i) || all.match(/\b(20\d{2})\b/);
  let year = yearM ? +(yearM[2] || yearM[1]) : new Date().getFullYear();
  if (year < 100) year += 2000;
  const money = /-?\(?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?/g;
  const begin = all.match(/(beginning|opening|previous)\s+balance[^\d\-(]*(-?\(?\$?[\d,]+\.\d{2}\)?)/i);
  const end = all.match(/(ending|closing|new)\s+balance[^\d\-(]*(-?\(?\$?[\d,]+\.\d{2}\)?)/i);
  let opening = begin ? parseAmount(begin[2]) ?? undefined : undefined;
  const closing = end ? parseAmount(end[2]) ?? undefined : undefined;
  let section: "credit" | "debit" | null = null;
  let prevBal = opening;
  const rows: BankRow[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^(deposits?|credits?|other credits|additions|electronic deposits)\b/i.test(l) && !/\d\.\d{2}/.test(l)) section = "credit";
    else if (/^(withdrawals?|debits?|checks?( paid)?|other debits|subtractions|electronic (payments|withdrawals)|fees|service charges)\b/i.test(l)) section = "debit";
    money.lastIndex = 0;
    const dm = l.match(/^(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|[A-Z][a-z]{2}\s+\d{1,2})\b/);
    if (!dm) continue;
    const date = parseDate(dm[1], year);
    if (!date) continue;
    const amts = l.match(money) || [];
    if (!amts.length) continue;
    let desc = l.slice(dm[0].length).replace(money, "").replace(/\s{2,}/g, " ").trim();
    const ref = desc.match(/\b(?:check|chk|ck)\s*#?\s*(\d{3,8})\b/i)?.[1] || (/^\d{3,8}$/.test(desc.split(" ")[0]) && section === "debit" ? desc.split(" ")[0] : undefined);
    let amount = parseAmount(amts[0])!;
    if (amts.length >= 2) {
      const bal = parseAmount(amts[amts.length - 1])!;
      const amt = Math.abs(parseAmount(amts[amts.length - 2])!);
      if (prevBal !== undefined && Math.abs(Math.abs(bal - prevBal) - amt) < 0.011) amount = bal > prevBal ? amt : -amt;
      else amount = section === "debit" ? -amt : section === "credit" ? amt : parseAmount(amts[amts.length - 2])!;
      prevBal = bal;
    } else if (section === "debit") amount = -Math.abs(amount);
    else if (section === "credit") amount = Math.abs(amount);
    if (!amount) continue;
    rows.push({ date, amount: Math.round(amount * 100) / 100, description: desc, ref });
  }
  if (!rows.length) warnings.push("No transaction lines found. If this is a scanned statement, it needs text recognition (OCR).");
  if (!section && rows.every((r) => r.amount > 0) && rows.length > 3) warnings.push("Couldn't tell deposits from withdrawals — please check signs before saving.");
  const dates = rows.map((r) => r.date).sort();
  return { rows, warnings, opening, closing, from: dates[0], to: dates[dates.length - 1] };
}

// ---------------- one entry point ----------------
export async function readBankStatement(file: File): Promise<BankParse> {
  const t0 = performance.now();
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop() || "";
  let out: Omit<BankParse, "ms">;
  if (ext === "xlsx" || ext === "xlsm") {
    const sheets = await readXlsx(file);
    const best = sheets.map((s) => bankRowsFromTable(s)).sort((a, b) => b.rows.length - a.rows.length)[0] || { rows: [], warnings: ["The workbook is empty."] };
    out = { format: "Excel", ...best };
  } else if (ext === "xls") {
    out = { format: "Excel 97", rows: [], warnings: ["Old .xls files: open in Excel and save as .xlsx or CSV, then upload again."] };
  } else if (ext === "pdf") {
    const lines = await pdfLines(file);
    out = { format: "PDF", ...bankRowsFromPdf(lines) };
  } else {
    const text = await file.text();
    if (/<OFX>|OFXHEADER/i.test(text)) out = { format: ext === "qfx" ? "QFX" : "OFX", ...parseOfx(text) };
    else if (/^01,/.test(text.trimStart())) out = { format: "BAI2", ...parseBai2(text) };
    else out = { format: ext === "txt" ? "Text" : "CSV", ...bankRowsFromTable(parseCsv(text)) };
  }
  const dates = out.rows.map((r) => r.date).sort();
  return { ...out, from: out.from || dates[0], to: out.to || dates[dates.length - 1], ms: Math.round(performance.now() - t0) };
}

/** Plain text of any supported document, for report and invoice reading. */
export async function documentText(file: File): Promise<{ text: string; tables: string[][][]; kind: string }> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") { const l = await pdfLines(file); return { text: l.join("\n"), tables: [], kind: "pdf" }; }
  if (ext === "xlsx" || ext === "xlsm") { const s = await readXlsx(file); return { text: s.map((t) => t.map((r) => r.join("  ")).join("\n")).join("\n"), tables: s, kind: "excel" }; }
  if (ext === "html" || ext === "htm") {
    const d = new DOMParser().parseFromString(await file.text(), "text/html");
    d.querySelectorAll("script,style").forEach((n) => n.remove());
    const rows = Array.from(d.querySelectorAll("tr")).map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent || "").trim()));
    return { text: rows.length ? rows.map((r) => r.join("  ")).join("\n") : (d.body?.innerText || d.body?.textContent || ""), tables: rows.length ? [rows] : [], kind: "html" };
  }
  if (["csv", "txt", "tsv", "xml", "json", "ofx", "qfx", "prn", "rpt"].includes(ext)) {
    const text = await file.text();
    if (ext === "xml") {
      const d = new DOMParser().parseFromString(text, "application/xml");
      const out: string[] = [];
      const walk = (n: Element) => { if (!n.children.length && n.textContent?.trim()) out.push(`${n.tagName}  ${n.textContent.trim()}`); Array.from(n.children).forEach(walk); };
      if (d.documentElement) walk(d.documentElement);
      return { text: out.join("\n"), tables: [], kind: "xml" };
    }
    return { text, tables: ext === "csv" || ext === "tsv" ? [parseCsv(text)] : [], kind: ext };
  }
  return { text: "", tables: [], kind: ext || "unknown" };
}
