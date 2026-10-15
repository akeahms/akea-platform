-- Monthly operating history (rooms, revenue, expenses, budget) for loan packages and investor reporting.
create or replace function public.monthly_history(p_hotels uuid[], p_from date, p_to date)
returns table (month date, rooms_available bigint, rooms_sold bigint, room_revenue numeric, total_revenue numeric, expenses numeric, budget_revenue numeric)
language sql stable security invoker set search_path = public as $$
  with m as (select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as mo),
  dm as (
    select date_trunc('month', business_date)::date as mo, sum(rooms_available) ra, sum(rooms_sold) rs, sum(room_revenue) rr,
           sum(room_revenue + fnb_revenue + other_revenue) tr
    from daily_metrics where hotel_id = any(p_hotels) and business_date between p_from and p_to group by 1),
  ex as (
    select date_trunc('month', je.entry_date)::date as mo, sum(jl.debit - jl.credit) e
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join gl_accounts a on a.id = jl.account_id
    where jl.hotel_id = any(p_hotels) and a.type = 'expense' and je.entry_date between p_from and p_to group by 1),
  bd as (select date_trunc('month', business_date)::date as mo, sum(total_revenue) b from budget_daily where hotel_id = any(p_hotels) and business_date between p_from and p_to group by 1)
  select m.mo, coalesce(dm.ra, 0)::bigint, coalesce(dm.rs, 0)::bigint, round(coalesce(dm.rr, 0), 2), round(coalesce(dm.tr, 0), 2), round(coalesce(ex.e, 0), 2), round(bd.b, 2)
  from m left join dm using (mo) left join ex using (mo) left join bd using (mo) order by 1
$$;
revoke execute on function public.monthly_history(uuid[], date, date) from public, anon;
grant execute on function public.monthly_history(uuid[], date, date) to authenticated;
