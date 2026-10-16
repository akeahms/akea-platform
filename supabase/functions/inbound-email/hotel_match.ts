// Which of a company's hotels a report email belongs to. Pure; unit-tested.
// Strongest first: the property code printed inside the report → a property code in the subject or file name
// → the hotel's name (with its city when two hotels share a name) in the subject or file name.
// Exactly one hotel must match at a step; a tie is "not sure" and the email waits for a person.
export type HotelRow = { id: string; name: string; city: string | null; property_code: string | null; report_email?: string | null };

const norm = (s: string) => ` ${s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
const tokens = (s: string) => new Set(s.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));

export function matchHotel(hotels: HotelRow[], subject: string, fileNames: string[], codesInReports: string[]): { hotel: HotelRow | null; how: string } {
  const one = (list: HotelRow[]) => (list.length === 1 ? list[0] : null);
  // 1) property code printed in the report
  for (const code of codesInReports.map((c) => c.trim().toUpperCase()).filter(Boolean)) {
    const h = one(hotels.filter((x) => (x.property_code || "").trim().toUpperCase() === code));
    if (h) return { hotel: h, how: `property code ${code} in the report` };
  }
  const where = `${subject} ${fileNames.join(" ")}`;
  // 2) property code as a whole word in the subject or file name (compared as plain text, never as a pattern)
  const tk = tokens(where);
  const byCode = hotels.filter((x) => (x.property_code || "").trim().length >= 3 && tk.has((x.property_code || "").trim().toUpperCase()));
  if (one(byCode)) return { hotel: byCode[0], how: "property code in the subject" };
  // 3) hotel name (+ city to break ties) in the subject or file name
  const w = norm(where);
  const byName = hotels.filter((x) => norm(x.name).trim().length >= 4 && w.includes(norm(x.name)));
  if (one(byName)) return { hotel: byName[0], how: "hotel name in the subject" };
  if (byName.length > 1) {
    // "Atwell Suites DFW Airport South" also contains "Atwell Suites": the longest name that contains all the others wins
    const longest = [...byName].sort((x, y) => norm(y.name).length - norm(x.name).length)[0];
    if (byName.every((x) => x === longest || norm(longest.name).includes(norm(x.name))) && byName.filter((x) => norm(x.name) === norm(longest.name)).length === 1)
      return { hotel: longest, how: "hotel name in the subject" };
    const byCity = byName.filter((x) => (x.city || "").trim().length >= 3 && w.includes(norm(x.city || "")));
    if (one(byCity)) return { hotel: byCity[0], how: "hotel name and city in the subject" };
  }
  return { hotel: null, how: byName.length > 1 || byCode.length > 1 ? "more than one hotel matched" : "no hotel matched" };
}

/** Business dates outside this window are kept as files but never change the day's numbers. */
export function dateInWindow(date: string, today: string, back = 60, ahead = 1): boolean {
  const d = Date.parse(date + "T12:00:00Z"), t = Date.parse(today + "T12:00:00Z");
  return Number.isFinite(d) && d >= t - back * 864e5 && d <= t + ahead * 864e5;
}

/** Optional sender allow-list: exact addresses or "@domain" entries. Empty list = accept any sender. */
export function senderAllowed(from: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const f = (from.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i)?.[0] || "").toLowerCase();
  return allowed.some((a) => { const x = a.trim().toLowerCase(); return x.startsWith("@") ? f.endsWith(x) : f === x; });
}

/** Constant-time text comparison for shared secrets. */
export function sameText(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
