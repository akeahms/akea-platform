-- US record-keeping and wage-hour safeguards.
--  1. Business records can't be deleted through the app or API (FLSA 29 CFR 516 payroll/time records, IRS books and
--     records). Corrections are made by editing (time punches, with a reason and a change log) or by reversing entries.
--     Maintenance run directly on the database (no app sign-in) and the platform's own functions are unaffected.
--  2. Every time-punch edit or removal is logged with the before/after values, who made it and why.
--  3. Journal entries can only be written by the platform's posting functions (balanced, audited), never directly.
--  4. Payroll hours: overtime is worked out per full workweek (Mon–Sun) even when the pay period cuts a week in two,
--     and the daily overtime rules of California, Alaska and Colorado are applied by the hotel's state.

-- 1. keep records ---------------------------------------------------------------------------------------------
create or replace function public._keep_records() returns trigger
language plpgsql set search_path = '' as $$
declare r text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if r in ('authenticated', 'anon') and coalesce(current_setting('akea.approved_path', true), '') <> 'on' then
    raise exception '% records are kept for legal record-keeping and can''t be deleted. Void, reverse or mark them inactive instead.',
      initcap(replace(tg_table_name, '_', ' '))
      using errcode = '42501';
  end if;
  return old;
end $$;

create trigger keep_records before delete on public.time_punches for each row execute function public._keep_records();
create trigger keep_records before delete on public.employees for each row execute function public._keep_records();
create trigger keep_records before delete on public.employee_pay for each row execute function public._keep_records();
create trigger keep_records before delete on public.journal_entries for each row execute function public._keep_records();
create trigger keep_records before delete on public.journal_lines for each row execute function public._keep_records();
create trigger keep_records before delete on public.bills for each row execute function public._keep_records();
create trigger keep_records before delete on public.checks for each row execute function public._keep_records();
create trigger keep_records before delete on public.bank_transactions for each row execute function public._keep_records();
create trigger keep_records before delete on public.refund_requests for each row execute function public._keep_records();

-- 2. time punch change log ------------------------------------------------------------------------------------
create table if not exists public.time_punch_changes (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  hotel_id uuid not null,
  employee_id uuid not null,
  punch_id uuid not null,
  action text not null check (action in ('edit', 'delete')),
  before jsonb not null,
  after jsonb,
  reason text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists time_punch_changes_punch on public.time_punch_changes(punch_id, changed_at);
create index if not exists time_punch_changes_emp on public.time_punch_changes(employee_id, changed_at);
alter table public.time_punch_changes enable row level security;
create policy time_punch_changes_read on public.time_punch_changes for select to authenticated using (
  public.can_access_hotel(hotel_id) and (public.perm_level(tenant_id, 'workforce') >= 2
    or employee_id in (select e.id from public.employees e where e.user_id = (select auth.uid()))));
revoke insert, update, delete on public.time_punch_changes from anon, authenticated;
grant select on public.time_punch_changes to authenticated;

create or replace function public._log_punch_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare keys text[] := array['clock_in', 'clock_out', 'break_minutes', 'employee_id', 'hotel_id'];
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(old) - 'approved_at' - 'approved_by' - 'edited_by' - 'edited_reason' - 'note')
       = (to_jsonb(new) - 'approved_at' - 'approved_by' - 'edited_by' - 'edited_reason' - 'note') then
      return new;   -- approvals and notes aren't time changes
    end if;
    -- a normal clock-out (open punch getting its out time, nothing else changing) isn't an edit either
    if old.clock_out is null and new.clock_out is not null and old.clock_in = new.clock_in
       and old.break_minutes = new.break_minutes and new.edited_reason is not distinct from old.edited_reason then
      return new;
    end if;
    insert into public.time_punch_changes(tenant_id, hotel_id, employee_id, punch_id, action, before, after, reason, changed_by)
    values (new.tenant_id, new.hotel_id, new.employee_id, new.id, 'edit',
      (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(keys) k),
      (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(keys) k),
      new.edited_reason, auth.uid());
    return new;
  end if;
  insert into public.time_punch_changes(tenant_id, hotel_id, employee_id, punch_id, action, before, reason, changed_by)
  values (old.tenant_id, old.hotel_id, old.employee_id, old.id, 'delete', to_jsonb(old), old.edited_reason, auth.uid());
  return old;
end $$;
revoke all on function public._log_punch_change() from public, anon, authenticated;

create trigger log_punch_change after update or delete on public.time_punches
  for each row execute function public._log_punch_change();

-- who edited: stamp edited_by on any time change made by a signed-in person
create or replace function public._stamp_punch_editor() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.clock_in, new.break_minutes) is distinct from (old.clock_in, old.break_minutes)
     or (old.clock_out is not null and new.clock_out is distinct from old.clock_out) then
    new.edited_by := coalesce(auth.uid(), new.edited_by);
  end if;
  return new;
end $$;
create trigger stamp_punch_editor before update on public.time_punches
  for each row execute function public._stamp_punch_editor();

-- 3. journal written only by posting functions ----------------------------------------------------------------
revoke insert, update, delete on public.journal_entries, public.journal_lines from anon, authenticated;

-- 4. payroll hours with full-workweek overtime and state daily rules -------------------------------------------
--   Federal (FLSA): over 40 hours in the workweek → 1.5×.
--   California: over 8 in a workday → 1.5×, over 12 → 2×; 7th consecutive day in the workweek: first 8 → 1.5×, beyond → 2×;
--               plus weekly over 40 (regular hours only, so nothing is counted twice).
--   Alaska: over 8 in a workday → 1.5×.   Colorado: over 12 in a workday → 1.5×.
--   Everywhere else: weekly rule only. Hours are attributed to the day the punch started (hotel's local time).
create or replace function public.payroll_hours_v2(p_from date, p_to date, p_hotels uuid[] default null)
returns table(employee_id uuid, employee text, hotel_id uuid, department text, dept_color text, pay_type text, rate numeric,
  days jsonb, total_hours numeric, regular_hours numeric, overtime_hours numeric, double_time_hours numeric, est_gross numeric,
  open_punches integer, unapproved integer, state text)
language sql stable set search_path = 'public' as $$
  with bounds as (
    select date_trunc('week', p_from)::date as wf, (date_trunc('week', p_to)::date + 6) as wt
  ), p as (
    select tp.*, (tp.clock_in at time zone h.timezone)::date as work_date, upper(coalesce(h.state, '')) as st,
      greatest(0, extract(epoch from (coalesce(tp.clock_out, tp.clock_in) - tp.clock_in)) / 3600 - tp.break_minutes / 60.0) as hrs
    from public.time_punches tp join public.hotels h on h.id = tp.hotel_id, bounds b
    where (tp.clock_in at time zone h.timezone)::date between b.wf and b.wt
      and (p_hotels is null or tp.hotel_id = any(p_hotels))
  ), day as (
    select p.employee_id, p.work_date, date_trunc('week', p.work_date)::date as wk, max(p.st) as st, sum(p.hrs) as h
    from p group by 1, 2, 3
  ), day2 as (
    select d.*, coalesce(ep.ot_eligible, true) as elig,
      count(*) over (partition by d.employee_id, d.wk) as days_in_wk,
      row_number() over (partition by d.employee_id, d.wk order by d.work_date) as n
    from day d left join public.employee_pay ep on ep.employee_id = d.employee_id
  ), split as (
    select d.*,
      case when not elig then h
           when st = 'CA' and days_in_wk = 7 and n = 7 then 0
           when st in ('CA', 'AK') then least(h, 8)
           when st = 'CO' then least(h, 12)
           else h end as r0,
      case when not elig then 0
           when st = 'CA' and days_in_wk = 7 and n = 7 then least(h, 8)
           when st = 'CA' then least(greatest(h - 8, 0), 4)
           when st = 'AK' then greatest(h - 8, 0)
           when st = 'CO' then greatest(h - 12, 0)
           else 0 end as o0,
      case when not elig then 0
           when st = 'CA' and days_in_wk = 7 and n = 7 then greatest(h - 8, 0)
           when st = 'CA' then greatest(h - 12, 0)
           else 0 end as t0
    from day2 d
  ), wkly as (
    select s.*, sum(r0) over (partition by employee_id, wk order by work_date) as cum from split s
  ), fin as (
    select w.employee_id, w.work_date, w.st, w.h,
      w.r0 - case when w.elig then greatest(0, w.cum - 40) - greatest(0, w.cum - w.r0 - 40) else 0 end as reg,
      w.o0 + case when w.elig then greatest(0, w.cum - 40) - greatest(0, w.cum - w.r0 - 40) else 0 end as ot,
      w.t0 as dt
    from wkly w
    where w.work_date between p_from and p_to
  ), t as (
    select f.employee_id, sum(f.h) as hrs, sum(f.reg) as reg, sum(f.ot) as ot, sum(f.dt) as dt, max(f.st) as st,
      jsonb_object_agg(f.work_date, round(f.h, 2)) as days
    from fin f group by 1
  ), c as (
    select p.employee_id, count(*) filter (where p.clock_out is null)::int as open_p,
      count(*) filter (where p.approved_at is null and p.clock_out is not null)::int as unapp
    from p where p.work_date between p_from and p_to group by 1
  )
  select e.id, e.first_name || ' ' || e.last_name, e.hotel_id, dp.name, dp.color, ep.pay_type, ep.rate,
    t.days, round(t.hrs, 2), round(t.reg, 2), round(t.ot, 2), round(t.dt, 2),
    case when ep.pay_type = 'hourly' then round(t.reg * ep.rate + t.ot * ep.rate * 1.5 + t.dt * ep.rate * 2, 2)
         when ep.pay_type = 'salary' then round(ep.rate / 365.0 * (p_to - p_from + 1), 2) end,
    coalesce(c.open_p, 0), coalesce(c.unapp, 0), nullif(t.st, '')
  from t join public.employees e on e.id = t.employee_id
  left join c on c.employee_id = t.employee_id
  left join public.departments dp on dp.id = e.department_id
  left join public.employee_pay ep on ep.employee_id = e.id
  order by e.hotel_id, dp.sort, e.last_name;
$$;
revoke all on function public.payroll_hours_v2(date, date, uuid[]) from public, anon;
grant execute on function public.payroll_hours_v2(date, date, uuid[]) to authenticated;

-- the original function keeps its columns (for anything still calling it) and now uses the same rules;
-- its overtime column includes double time.
create or replace function public.payroll_hours(p_from date, p_to date, p_hotels uuid[] default null)
returns table(employee_id uuid, employee text, hotel_id uuid, department text, dept_color text, pay_type text, rate numeric,
  days jsonb, total_hours numeric, regular_hours numeric, overtime_hours numeric, est_gross numeric, open_punches integer, unapproved integer)
language sql stable set search_path = 'public' as $$
  select employee_id, employee, hotel_id, department, dept_color, pay_type, rate, days, total_hours, regular_hours,
    overtime_hours + double_time_hours, est_gross, open_punches, unapproved
  from public.payroll_hours_v2(p_from, p_to, p_hotels)
$$;
