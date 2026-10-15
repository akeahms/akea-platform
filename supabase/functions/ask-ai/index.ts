// Ask AI: plain-English questions answered from the company's own data.
// Every lookup runs with the asker's own sign-in, so row-level security limits answers to what they may see.
// Secrets: ANTHROPIC_API_KEY (required), AI_MODEL (optional).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";
const SB_URL = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");

const TABLES: Record<string, string> = {
  hotels: "id, name, brand_family, city, state, rooms, status (operating|development), opening_date, timezone, str_id",
  daily_metrics: "hotel_id, business_date, rooms_available, rooms_sold, out_of_order, comp_rooms, no_shows, arrivals, departures, in_house_guests, room_revenue, fnb_revenue, other_revenue, data_source (sample|report|live)",
  budget_daily: "hotel_id, business_date, rooms_sold, room_revenue, total_revenue",
  str_periods: "hotel_id, period_type (month), period_end, occ, occ_comp, adr, adr_comp, revpar, revpar_comp, mpi, ari, rgi",
  reports: "hotel_id, report_type, business_date, file_name, status, received_at",
  employees: "id, hotel_id, first_name, last_name, department_id, position, employment_type, status, hire_date",
  departments: "id, name",
  shifts: "hotel_id, employee_id, department_id, position, starts_at, ends_at, break_minutes, published",
  time_punches: "hotel_id, employee_id, clock_in, clock_out, break_minutes, approved_at",
  vendors: "id, name, category, payment_terms, is_1099, w9_on_file",
  bills: "hotel_id, vendor_id, invoice_no, invoice_date, due_date, amount, status (draft|pending_approval|approved|scheduled|paid|rejected), paid_at",
  purchase_orders: "hotel_id, vendor_id, po_no, status, total, needed_by",
  gl_accounts: "id, number, name, type, section",
  bank_accounts: "id, hotel_id, name, institution, balance, balance_as_of",
  bank_transactions: "hotel_id, bank_account_id, posted_date, amount, description, status (unmatched|matched|excluded), matched_kind",
  expected_deposits: "hotel_id, business_date, source, amount, expected_date, status (open|matched)",
  permits: "hotel_id, kind, number, issuer, expires_on",
  insurance_policies: "hotel_id, kind, carrier, policy_no, premium, expires_on",
  documents: "hotel_id, folder, name, expires_on, tax_year",
  investors: "id, name", investor_holdings: "investor_id, hotel_id, ownership_pct, capital_contributed", distributions: "investor_id, hotel_id, paid_on, amount",
  construction_budget: "hotel_id, category, line, budget, committed, spent", construction_draws: "hotel_id, draw_no, amount, status, funded_on", construction_milestones: "hotel_id, name, planned_on, actual_on, status",
};
const RPCS: Record<string, string> = {
  kpi_summary: "(p_from date, p_to date, p_hotels uuid[] | null) → per-hotel totals: rooms_available, rooms_sold, room_revenue, fnb_revenue, other_revenue …",
  pnl: "(p_from date, p_to date, p_hotels uuid[] | null) → section, account, number, kind, actual, budget, last_year",
  payroll_hours: "(p_from date, p_to date, p_hotels uuid[] | null) → employee, department, total_hours, regular_hours, overtime_hours, est_gross",
  monthly_history: "(p_hotels uuid[], p_from date, p_to date) → month, rooms_available, rooms_sold, room_revenue, total_revenue, expenses, budget_revenue",
  missing_reports: "(p_date date) → hotel_id, report_type",
  investor_summary: "(p_year int) → investor, hotel, ownership_pct, capital, distributions_ytd, distributions_total",
};

async function rest(auth: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const auth = req.headers.get("Authorization") || "";
  const key = env("ANTHROPIC_API_KEY");
  if (!key) return json({ configured: false, answer: "Ask AI isn't switched on yet. An administrator needs to add an Anthropic API key in Supabase → Edge Functions → Secrets (name: ANTHROPIC_API_KEY)." });
  const who = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!who.ok) return json({ error: "Please sign in again." }, 401);
  const { question, history = [], today } = await req.json().catch(() => ({}));
  if (!question || String(question).length > 2000) return json({ error: "Ask a question (up to 2,000 characters)." }, 400);

  const system = `You answer questions about a hotel management company's own data for a signed-in user. Today is ${today || new Date().toISOString().slice(0, 10)} (US Central time).
Use the tools to look data up; never guess numbers. The data you can read is already limited to what this user is allowed to see — if something comes back empty, say you don't see it rather than speculating.
Hotel KPIs: Occupancy = rooms_sold / rooms_available. ADR = room_revenue / rooms_sold. RevPAR = room_revenue / rooms_available. TRevPAR = (room+fnb+other revenue) / rooms_available. Same-day last year = 364 days earlier.
Rows with data_source = 'sample' are demonstration data — mention that when your answer relies on them.
Answer in plain English for a hotel owner: lead with the answer, then a short table or bullets if helpful. Use US dollar formatting. Keep it concise.
Tables (PostgREST, read-only): ${Object.entries(TABLES).map(([t, c]) => `${t}(${c})`).join("; ")}.
Functions: ${Object.entries(RPCS).map(([f, s]) => `${f}${s}`).join("; ")}.
Always look up hotel ids by name in the hotels table first when the user names a hotel.`;

  const tools = [
    { name: "query_table", description: "Read rows from a table with PostgREST filters. Example filters: 'hotel_id=eq.<uuid>&business_date=gte.2026-10-01&order=business_date.asc'. Max 500 rows.",
      input_schema: { type: "object", properties: { table: { type: "string", enum: Object.keys(TABLES) }, select: { type: "string", description: "columns, e.g. 'hotel_id,business_date,rooms_sold'. Aggregates like 'amount.sum()' are allowed." }, filters: { type: "string" }, limit: { type: "integer" } }, required: ["table", "select"] } },
    { name: "call_function", description: "Call a reporting function with JSON arguments.",
      input_schema: { type: "object", properties: { name: { type: "string", enum: Object.keys(RPCS) }, args: { type: "object" } }, required: ["name", "args"] } },
  ];
  const messages: any[] = [...(history as any[]).slice(-6).map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) })), { role: "user", content: String(question) }];
  const steps: { tool: string; detail: string; rows: number }[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: env("AI_MODEL") || "claude-sonnet-5-5", max_tokens: 1800, system, tools, messages }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `AI service error ${r.status}`);
      messages.push({ role: "assistant", content: j.content });
      const uses = (j.content || []).filter((c: any) => c.type === "tool_use");
      if (j.stop_reason !== "tool_use" || !uses.length) {
        const answer = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
        return json({ configured: true, answer, steps });
      }
      const results = [];
      for (const u of uses) {
        let out: unknown;
        try {
          if (u.name === "query_table") {
            const { table, select, filters = "", limit = 200 } = u.input;
            if (!TABLES[table]) throw new Error("Unknown table");
            const f = String(filters).replace(/^[?&]+/, "").replace(/(^|&)(select|limit)=[^&]*/g, "");
            out = await rest(auth, `${table}?select=${encodeURIComponent(select)}${f ? "&" + f : ""}&limit=${Math.min(500, Number(limit) || 200)}`);
            steps.push({ tool: table, detail: f, rows: Array.isArray(out) ? out.length : 0 });
          } else {
            const { name, args } = u.input;
            if (!RPCS[name]) throw new Error("Unknown function");
            out = await rest(auth, `rpc/${name}`, { method: "POST", body: JSON.stringify(args || {}) });
            steps.push({ tool: name, detail: JSON.stringify(args), rows: Array.isArray(out) ? out.length : 1 });
          }
        } catch (e) { out = { error: (e as Error).message }; }
        const s = JSON.stringify(out);
        results.push({ type: "tool_result", tool_use_id: u.id, content: s.length > 60000 ? s.slice(0, 60000) + "…(truncated)" : s });
      }
      messages.push({ role: "user", content: results });
    }
    return json({ configured: true, answer: "That question needed more lookups than I can do at once. Try narrowing it to a hotel or a date range.", steps });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
