-- Phase 7 security review fixes.

-- 1) A journal line pointing at another company's (or a missing) account now fails the whole entry
--    instead of being dropped silently (which could leave an unbalanced entry).
create or replace function public.post_journal(p_hotel uuid, p_date date, p_memo text, p_lines jsonb, p_source text default 'manual', p_source_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; jid uuid; dr numeric; cr numeric;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null or not public.can_access_hotel(p_hotel) or public.perm_level(t, 'finance') < 2 then raise exception 'Not allowed'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then raise exception 'An entry needs at least two lines'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l
             where not exists (select 1 from gl_accounts a where a.id = (l->>'account_id')::uuid and a.tenant_id = t)) then
    raise exception 'Every line needs an account from this company''s chart of accounts';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where coalesce((l->>'debit')::numeric, 0) < 0 or coalesce((l->>'credit')::numeric, 0) < 0) then
    raise exception 'Debits and credits cannot be negative';
  end if;
  select coalesce(sum((l->>'debit')::numeric), 0), coalesce(sum((l->>'credit')::numeric), 0) into dr, cr from jsonb_array_elements(p_lines) l;
  if round(dr, 2) <> round(cr, 2) or dr = 0 then raise exception 'Entry does not balance (debits %, credits %)', dr, cr; end if;
  insert into journal_entries(tenant_id, hotel_id, entry_date, memo, source, source_id) values (t, p_hotel, p_date, p_memo, p_source, p_source_id) returning id into jid;
  insert into journal_lines(entry_id, tenant_id, hotel_id, account_id, debit, credit, memo)
  select jid, t, p_hotel, (l->>'account_id')::uuid, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0), l->>'memo'
  from jsonb_array_elements(p_lines) l;
  return jid;
end $$;

-- 2) Shared-tablet PIN lockout: 5 wrong PINs on one hotel's time clock within 10 minutes locks PIN entry for 10 minutes.
create table if not exists public.pin_attempts (
  id bigint generated always as identity primary key,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  user_id uuid default auth.uid(),
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists pin_attempts_hotel_at on public.pin_attempts(hotel_id, at desc);
alter table public.pin_attempts enable row level security;   -- server only: written by clock(), no client policies
revoke all on public.pin_attempts from anon, authenticated;

create or replace function public.clock(p_action text, p_hotel uuid default null, p_pin text default null, p_employee uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare e public.employees; p public.time_punches; sid uuid; src text; mins numeric; fails int;
begin
  if p_pin is not null then
    if p_hotel is null or not public.can_access_hotel(p_hotel) or public.perm_level((select tenant_id from hotels where id = p_hotel), 'workforce') < 2 then
      raise exception 'This device is not set up as a time clock for that hotel';
    end if;
    select count(*) into fails from public.pin_attempts
      where hotel_id = p_hotel and not ok and at > now() - interval '10 minutes'
        and at > coalesce((select max(at) from public.pin_attempts where hotel_id = p_hotel and ok), '-infinity');
    if fails >= 5 then raise exception 'Too many wrong PINs. The time clock is locked for 10 minutes; a manager can clock people in from the Time Clock page.'; end if;
    select * into e from public.employees x where x.hotel_id = p_hotel and x.status = 'active' and x.pin_hash is not null and x.pin_hash = crypt(p_pin, x.pin_hash) limit 1;
    insert into public.pin_attempts(hotel_id, ok) values (p_hotel, e.id is not null);
    -- Return (not raise) so the failed attempt stays recorded for the lockout.
    if e.id is null then return jsonb_build_object('error', 'PIN not recognised', 'attempts_left', greatest(0, 4 - fails)); end if;
    src := 'kiosk';
  elsif p_employee is not null then
    select * into e from public.employees where id = p_employee;
    if e.id is null or not public.can_access_hotel(e.hotel_id) or public.perm_level(e.tenant_id, 'workforce') < 2 then raise exception 'Not allowed'; end if;
    src := 'manager';
  else
    select * into e from public.employees where user_id = auth.uid() and status = 'active' and (p_hotel is null or hotel_id = p_hotel) order by created_at limit 1;
    if e.id is null then raise exception 'Your sign-in is not linked to an employee profile yet'; end if;
    src := 'web';
  end if;

  if p_action = 'in' then
    if exists (select 1 from public.time_punches where employee_id = e.id and clock_out is null) then
      raise exception '% is already clocked in', e.first_name;
    end if;
    select id into sid from public.shifts where employee_id = e.id and starts_at <= now() + interval '2 hours' and ends_at >= now() order by starts_at limit 1;
    insert into public.time_punches(tenant_id, hotel_id, employee_id, shift_id, clock_in, source)
      values (e.tenant_id, e.hotel_id, e.id, sid, now(), src) returning * into p;
  elsif p_action = 'out' then
    update public.time_punches set clock_out = now()
      where employee_id = e.id and clock_out is null returning * into p;
    if p.id is null then raise exception '% is not clocked in', e.first_name; end if;
  elsif p_action = 'status' then
    select * into p from public.time_punches where employee_id = e.id order by clock_in desc limit 1;
  else
    raise exception 'Unknown action';
  end if;
  mins := extract(epoch from (coalesce(p.clock_out, now()) - p.clock_in)) / 60;
  return jsonb_build_object('employee', e.first_name || ' ' || e.last_name, 'employee_id', e.id,
    'clocked_in', p.clock_out is null and p.id is not null, 'clock_in', p.clock_in, 'clock_out', p.clock_out, 'minutes', round(mins));
end $$;

-- 3) Signed-out visitors have no reason to call report functions (row security already returns nothing; this removes the endpoint).
revoke execute on function public.budget_summary, public.daily_series, public.kpi_summary, public.missing_reports from anon, public;
grant execute on function public.budget_summary, public.daily_series, public.kpi_summary, public.missing_reports to authenticated;
