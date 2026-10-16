-- Phase 7 isolation test findings. RESTRICTIVE policies are ANDed with the existing read policies,
-- so these narrow access without dropping anything.

-- Hotel performance (revenue, occupancy, budgets, segments, report stats): only roles that work with numbers.
create or replace function public.sees_performance(h uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from hotels x where x.id = h and greatest(public.perm_level(x.tenant_id, 'dashboards'), public.perm_level(x.tenant_id, 'reports'),
                 public.perm_level(x.tenant_id, 'finance'), public.perm_level(x.tenant_id, 'str')) >= 1)
$$;
revoke execute on function public.sees_performance(uuid) from public, anon;
grant execute on function public.sees_performance(uuid) to authenticated;

create policy daily_metrics_need_perf on public.daily_metrics as restrictive for select to authenticated using (public.sees_performance(hotel_id));
create policy budget_daily_need_perf on public.budget_daily as restrictive for select to authenticated using (public.sees_performance(hotel_id));
create policy daily_segments_need_perf on public.daily_segments as restrictive for select to authenticated using (public.sees_performance(hotel_id));
create policy report_stats_need_perf on public.report_stats as restrictive for select to authenticated using (public.sees_performance(hotel_id));

-- Report inbox and required-report list: reports or dashboards permission.
create policy reports_need_perm on public.reports as restrictive for select to authenticated
  using (greatest(public.perm_level(tenant_id, 'reports'), public.perm_level(tenant_id, 'dashboards'), public.perm_level(tenant_id, 'finance')) >= 1);
create policy required_reports_need_perm on public.required_reports as restrictive for select to authenticated
  using (exists (select 1 from hotels x where x.id = hotel_id and greatest(public.perm_level(x.tenant_id, 'reports'), public.perm_level(x.tenant_id, 'dashboards')) >= 1));

-- Schedules: people who can't edit the schedule only see published shifts.
create policy shifts_published_only on public.shifts as restrictive for select to authenticated
  using (published or public.perm_level(tenant_id, 'workforce') >= 2);
