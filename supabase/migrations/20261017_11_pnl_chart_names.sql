-- P&L: revenue lines take their number and name from the chart's revenue accounts (by role), and every account that is
-- inactive shows as "NAME (Inactive)" so reports for past dates still include it.
create or replace function public.pnl(p_from date, p_to date, p_hotels uuid[] default null::uuid[])
 returns table(section text, account text, number text, kind text, actual numeric, budget numeric, last_year numeric)
 language sql stable set search_path to 'public'
as $function$
  with h as (select id, tenant_id from hotels where (p_hotels is null or id = any(p_hotels)) and public.can_access_hotel(id)),
  -- revenue lines take their number and name from the chart (the hotel's own account when one hotel is shown, else the company template)
  lbl as (
    select k.key, coalesce(g.number, k.num) num,
           coalesce(g.name || case when g.active then '' else ' (Inactive)' end, k.nm) acct,
           coalesce(g.section, 'Revenue') sec
    from (values ('room_revenue', '4000', 'Room Revenue'), ('fnb_revenue', '4100', 'Food & Beverage Revenue'), ('other_revenue', '4200', 'Other Operated Revenue')) k(key, num, nm)
    left join lateral (
      select x.number, x.name, x.active, x.section from gl_accounts x
      where x.system_key = k.key and x.tenant_id in (select tenant_id from h)
        and ((select count(*) from h) = 1 and x.hotel_id = (select id from h limit 1) or (select count(*) from h) <> 1 and x.hotel_id is null)
      limit 1) g on true
  ),
  rev as (
    select x.key, sum(x.cur) cur, sum(x.ly) ly from (
      select 'room_revenue' key,
             sum(dm.room_revenue) filter (where dm.business_date between p_from and p_to) cur,
             sum(dm.room_revenue) filter (where dm.business_date between p_from - 364 and p_to - 364) ly
        from daily_metrics dm join h on h.id = dm.hotel_id where dm.business_date between p_from - 364 and p_to
      union all
      select 'fnb_revenue', sum(dm.fnb_revenue) filter (where dm.business_date between p_from and p_to),
             sum(dm.fnb_revenue) filter (where dm.business_date between p_from - 364 and p_to - 364)
        from daily_metrics dm join h on h.id = dm.hotel_id where dm.business_date between p_from - 364 and p_to
      union all
      select 'other_revenue', sum(dm.other_revenue) filter (where dm.business_date between p_from and p_to),
             sum(dm.other_revenue) filter (where dm.business_date between p_from - 364 and p_to - 364)
        from daily_metrics dm join h on h.id = dm.hotel_id where dm.business_date between p_from - 364 and p_to
    ) x group by 1
  ),
  rev_b as (
    select 'room_revenue' key, sum(bd.room_revenue) b from budget_daily bd join h on h.id = bd.hotel_id where bd.business_date between p_from and p_to
    union all
    select 'other_revenue', sum(bd.total_revenue - bd.room_revenue) from budget_daily bd join h on h.id = bd.hotel_id where bd.business_date between p_from and p_to
  ),
  exp as (
    select a.section sec, a.name || case when a.active then '' else ' (Inactive)' end acct, a.number num, 'expense'::text k,
           sum(jl.debit - jl.credit) filter (where je.entry_date between p_from and p_to) cur,
           sum(jl.debit - jl.credit) filter (where je.entry_date between p_from - 364 and p_to - 364) ly
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join h on h.id = jl.hotel_id
    join gl_accounts a on a.id = jl.account_id
    where a.type = 'expense' and je.entry_date between p_from - 364 and p_to
    group by 1, 2, 3
  ),
  exp_b as (
    select a.number num, sum(bg.amount * (least(p_to, (bg.month + interval '1 month - 1 day')::date) - greatest(p_from, bg.month) + 1)::numeric
                             / ((bg.month + interval '1 month')::date - bg.month)) b
    from budget_gl bg join h on h.id = bg.hotel_id join gl_accounts a on a.id = bg.account_id
    where bg.month <= p_to and (bg.month + interval '1 month - 1 day')::date >= p_from and bg.version = 'Budget'
    group by 1
  )
  select l.sec, l.acct, l.num, 'revenue'::text, round(coalesce(r.cur, 0), 2), round((select sum(b) from rev_b where rev_b.key = r.key), 2), round(r.ly, 2)
    from rev r join lbl l on l.key = r.key
  union all
  select e.sec, e.acct, e.num, e.k, round(coalesce(e.cur, 0), 2), round((select b from exp_b where exp_b.num = e.num), 2), round(e.ly, 2) from exp e
  order by 4 desc, 3;
$function$;
