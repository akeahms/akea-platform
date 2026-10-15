-- Phase 2: Workforce — departments, employees, pay, schedule, time clock, payroll hours.

create extension if not exists pgcrypto with schema extensions;

-- Standard row-level security for a table: read at level >= 1 of a module, write at >= 2.
-- hotel_mode: 'hotel' (hotel_id required), 'optional' (hotel_id may be null = company-wide), 'tenant' (no hotel column).
create or replace function public._std_rls(tbl text, module text, hotel_mode text, write_level int default 2, with_read boolean default true)
returns void language plpgsql as $$
declare scope text;
begin
  scope := case hotel_mode
    when 'hotel' then 'public.can_access_hotel(hotel_id)'
    when 'optional' then '((hotel_id is null and tenant_id in (select public.my_tenant_ids())) or public.can_access_hotel(hotel_id))'
    else 'tenant_id in (select public.my_tenant_ids())' end;
  execute format('alter table public.%I enable row level security', tbl);
  if with_read then
  execute format('create policy %I on public.%I for select to authenticated using (%s and public.perm_level(tenant_id, %L) >= 1)', tbl || '_read', tbl, scope, module);
  end if;
  execute format('create policy %I on public.%I for all to authenticated using (%s and public.perm_level(tenant_id, %L) >= %s) with check (%s and public.perm_level(tenant_id, %L) >= %s)',
    tbl || '_write', tbl, scope, module, write_level, scope, module, write_level);
end $$;
revoke execute on function public._std_rls(text, text, text, int, boolean) from public, anon, authenticated;

-- ---------- tables ----------
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, color text not null default '#64748B', sort int not null default 0,
  unique (tenant_id, name)
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  first_name text not null, last_name text not null,
  email text, phone text,
  department_id uuid references public.departments(id) on delete set null,
  position text,
  employment_type text not null default 'full_time' check (employment_type in ('full_time','part_time','seasonal','contract')),
  status text not null default 'active' check (status in ('active','inactive','terminated')),
  hire_date date, pin_hash text,
  data_source text not null default 'live',
  created_at timestamptz not null default now()
);
create index if not exists employees_hotel on public.employees(hotel_id, status);
create index if not exists employees_user on public.employees(user_id);

create table if not exists public.employee_pay (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  pay_type text not null default 'hourly' check (pay_type in ('hourly','salary')),
  rate numeric(12,2) not null default 0,         -- hourly rate, or annual salary
  ot_eligible boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,   -- null = open shift
  department_id uuid references public.departments(id) on delete set null,
  position text,
  starts_at timestamptz not null, ends_at timestamptz not null,
  break_minutes int not null default 0,
  notes text, published boolean not null default false,
  created_by uuid default auth.uid(),
  data_source text not null default 'live',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists shifts_hotel_time on public.shifts(hotel_id, starts_at);

create table if not exists public.time_punches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  shift_id uuid references public.shifts(id) on delete set null,
  clock_in timestamptz not null, clock_out timestamptz,
  break_minutes int not null default 0,
  source text not null default 'web' check (source in ('web','kiosk','mobile','manager')),
  note text, edited_by uuid, edited_reason text,
  approved_by uuid, approved_at timestamptz,
  data_source text not null default 'live',
  created_at timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);
create index if not exists punches_hotel_time on public.time_punches(hotel_id, clock_in);
create index if not exists punches_emp on public.time_punches(employee_id, clock_in);
create unique index if not exists punches_one_open on public.time_punches(employee_id) where clock_out is null;

-- ---------- security ----------
select public._std_rls('departments', 'workforce', 'tenant', 4);
select public._std_rls('employees', 'workforce', 'hotel');
select public._std_rls('employee_pay', 'workforce', 'hotel', 3, false);
-- pay is visible only to approve level and above
create policy employee_pay_read on public.employee_pay for select to authenticated
  using (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'workforce') >= 3);
select public._std_rls('shifts', 'workforce', 'hotel');
select public._std_rls('time_punches', 'workforce', 'hotel', 2, false);
-- line staff (view level) see only their own punches
create policy time_punches_read on public.time_punches for select to authenticated using (
  public.can_access_hotel(hotel_id) and (
    public.perm_level(tenant_id, 'workforce') >= 2
    or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())));
-- everyone may see their own employee record even without workforce access
create policy employees_read_self on public.employees for select to authenticated using (user_id = auth.uid());

-- ---------- default departments (luxury palette, distinct hues) ----------
create or replace function public.create_default_departments(t uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.departments(tenant_id, name, color, sort) values
    (t, 'Front Office', '#2F5BD3', 1), (t, 'Housekeeping', '#C0396B', 2), (t, 'Laundry', '#0E8A9A', 3),
    (t, 'Maintenance', '#B7741A', 4), (t, 'Breakfast & F&B', '#2E8B57', 5), (t, 'Night Audit', '#5146C9', 6),
    (t, 'Sales', '#8E44AD', 7), (t, 'Management', '#8A6A2F', 8)
  on conflict (tenant_id, name) do nothing;
$$;
revoke execute on function public.create_default_departments(uuid) from public, anon, authenticated;
select public.create_default_departments(id) from public.tenants;

-- ---------- PIN for the shared time-clock tablet ----------
create or replace function public.set_employee_pin(p_employee uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e public.employees;
begin
  select * into e from public.employees where id = p_employee;
  if e.id is null or not public.can_access_hotel(e.hotel_id) or public.perm_level(e.tenant_id, 'workforce') < 2 then
    raise exception 'Not allowed';
  end if;
  if p_pin !~ '^\d{4,6}$' then raise exception 'PIN must be 4 to 6 digits'; end if;
  if exists (select 1 from public.employees x where x.hotel_id = e.hotel_id and x.id <> e.id and x.status = 'active'
             and x.pin_hash is not null and x.pin_hash = crypt(p_pin, x.pin_hash)) then
    raise exception 'Another employee at this hotel already uses that PIN';
  end if;
  update public.employees set pin_hash = crypt(p_pin, gen_salt('bf', 8)) where id = e.id;
end $$;

-- ---------- clock in / out ----------
-- Self service (signed-in employee) or shared tablet (manager session + employee PIN).
create or replace function public.clock(p_action text, p_hotel uuid default null, p_pin text default null, p_employee uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare e public.employees; p public.time_punches; sid uuid; src text; mins numeric;
begin
  if p_pin is not null then
    if p_hotel is null or not public.can_access_hotel(p_hotel) or public.perm_level((select tenant_id from hotels where id = p_hotel), 'workforce') < 2 then
      raise exception 'This device is not set up as a time clock for that hotel';
    end if;
    select * into e from public.employees x where x.hotel_id = p_hotel and x.status = 'active' and x.pin_hash is not null and x.pin_hash = crypt(p_pin, x.pin_hash) limit 1;
    if e.id is null then raise exception 'PIN not recognised'; end if;
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

-- ---------- payroll hours (daily hours, weekly overtime over 40) ----------
-- Work date = the day the punch started, in the hotel's time zone. Security invoker: row access follows the caller.
create or replace function public.payroll_hours(p_from date, p_to date, p_hotels uuid[] default null)
returns table (employee_id uuid, employee text, hotel_id uuid, department text, dept_color text, pay_type text, rate numeric,
               days jsonb, total_hours numeric, regular_hours numeric, overtime_hours numeric, est_gross numeric, open_punches int, unapproved int)
language sql stable security invoker set search_path = public as $$
  with p as (
    select tp.*, (tp.clock_in at time zone h.timezone)::date as work_date,
      greatest(0, extract(epoch from (coalesce(tp.clock_out, tp.clock_in) - tp.clock_in)) / 3600 - tp.break_minutes / 60.0) as hrs
    from public.time_punches tp join public.hotels h on h.id = tp.hotel_id
    where (tp.clock_in at time zone h.timezone)::date between p_from and p_to
      and (p_hotels is null or tp.hotel_id = any(p_hotels))
  ), wk as (
    select p.employee_id, date_trunc('week', p.work_date)::date as wk, sum(p.hrs) as hrs from p group by 1, 2
  ), ot as (
    select wk.employee_id, sum(greatest(0, wk.hrs - 40)) as ot from wk group by 1
  ), d as (
    select p.employee_id, jsonb_object_agg(p.work_date, round(p.hrs_day, 2)) as days
    from (select employee_id, work_date, sum(hrs) as hrs_day from p group by 1, 2) p group by 1
  ), t as (
    select employee_id, sum(hrs) as hrs, count(*) filter (where clock_out is null)::int as open_p,
      count(*) filter (where approved_at is null and clock_out is not null)::int as unapp
    from p group by 1
  )
  select e.id, e.first_name || ' ' || e.last_name, e.hotel_id, dp.name, dp.color, ep.pay_type, ep.rate,
    d.days, round(t.hrs, 2),
    round(t.hrs - case when coalesce(ep.ot_eligible, true) then coalesce(ot.ot, 0) else 0 end, 2),
    round(case when coalesce(ep.ot_eligible, true) then coalesce(ot.ot, 0) else 0 end, 2),
    case when ep.pay_type = 'hourly' then round((t.hrs - case when coalesce(ep.ot_eligible, true) then coalesce(ot.ot, 0) else 0 end) * ep.rate
                                               + case when coalesce(ep.ot_eligible, true) then coalesce(ot.ot, 0) else 0 end * ep.rate * 1.5, 2)
         when ep.pay_type = 'salary' then round(ep.rate / 365.0 * (p_to - p_from + 1), 2) end,
    t.open_p, t.unapp
  from t join public.employees e on e.id = t.employee_id
  left join public.departments dp on dp.id = e.department_id
  left join public.employee_pay ep on ep.employee_id = e.id
  left join ot on ot.employee_id = e.id
  left join d on d.employee_id = e.id
  order by e.hotel_id, dp.sort, e.last_name;
$$;

create or replace function public.approve_punches(p_ids uuid[]) returns int
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  update public.time_punches tp set approved_by = auth.uid(), approved_at = now()
   where tp.id = any(p_ids) and tp.clock_out is not null and public.perm_level(tp.tenant_id, 'workforce') >= 3;
  get diagnostics n = row_count;
  return n;
end $$;

-- principal sees and runs everything in workforce / operations
update public.role_permissions rp set level = 'admin' from public.roles r
 where rp.role_id = r.id and r.key = 'principal' and rp.module in ('workforce', 'operations');

revoke execute on function public.clock(text, uuid, text, uuid) from public, anon;
revoke execute on function public.set_employee_pin(uuid, text) from public, anon;
revoke execute on function public.payroll_hours(date, date, uuid[]) from public, anon;
revoke execute on function public.approve_punches(uuid[]) from public, anon;
grant execute on function public.clock(text, uuid, text, uuid), public.set_employee_pin(uuid, text),
  public.payroll_hours(date, date, uuid[]), public.approve_punches(uuid[]) to authenticated;
