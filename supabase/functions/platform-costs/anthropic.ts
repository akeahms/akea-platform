// Anthropic Admin API cost report → monthly totals. Pure except for fetch; unit-tested with a mocked fetch.
// Needs an Admin API key (starts with sk-ant-admin) in the ANTHROPIC_ADMIN_KEY secret. Regular API keys can't read costs.
export type MonthCost = { month: string; amount: number; days: number };

/** Sum the daily cost buckets from `from` (inclusive) to `to` (exclusive) into calendar months (UTC). Amounts arrive in cents. */
export async function anthropicMonthlyCosts(key: string, from: Date, to: Date, f: typeof fetch = fetch): Promise<MonthCost[]> {
  const months = new Map<string, MonthCost>();
  let page: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const q = new URLSearchParams({ starting_at: from.toISOString(), ending_at: to.toISOString(), bucket_width: "1d", limit: "31" });
    if (page) q.set("page", page);
    const r = await f(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.error?.message || `Anthropic returned ${r.status}`;
      throw new Error(r.status === 401 || r.status === 403 ? `Anthropic didn't accept the key (${msg}). Use an Admin API key (sk-ant-admin…) in ANTHROPIC_ADMIN_KEY.` : msg);
    }
    for (const b of j.data || []) {
      const month = String(b.starting_at).slice(0, 7);
      const cents = (b.results || []).filter((x: any) => (x.currency || "USD") === "USD").reduce((a: number, x: any) => a + (parseFloat(x.amount) || 0), 0);
      const m = months.get(month) || { month, amount: 0, days: 0 };
      m.amount += cents / 100; m.days += 1;
      months.set(month, m);
    }
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return [...months.values()].map((m) => ({ ...m, amount: Math.round(m.amount * 100) / 100 })).sort((a, b) => a.month.localeCompare(b.month));
}
