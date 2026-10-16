-- Shift swaps: give a shift away, claim a coworker's shift, or pick up an open shift. A schedule manager approves.
create table if not exists public.shift_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  kind text not null check (kind in ('giveaway','pickup')),
  from_employee uuid references public.employees(id) on delete set null,   -- who gives it away (null for open shifts)
  to_employee uuid references public.employees(id) on delete set null,     -- who takes it
  status text not null default 'open' check (status in ('open','claimed','approved','declined','cancelled')),
  note text, decided_by uuid, decided_at timestamptz, decision_note text,
  created_by uuid default auth.uid(), created_at timestamptz not null default now()
);
create index if not exists shift_requests_hotel on public.shift_requests(hotel_id, status);
create unique index if not exists shift_requests_one_active on public.shift_requests(shift_id) where status in ('open','claimed');
alter table public.shift_requests enable row level security;
-- Read: anyone on the schedule at that hotel (staff need to see shifts up for grabs). Writes only through the functions below.
create policy shift_requests_read on public.shift_requests for select to authenticated
  using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'workforce') >= 1);
revoke insert, update, delete on public.shift_requests from anon, authenticated;

-- the signed-in person's active employee record at a hotel
create or replace function public._me_at(p_hotel uuid) returns public.employees
language sql stable security definer set search_path = public as $$
  select * from public.employees where user_id = auth.uid() and hotel_id = p_hotel and status = 'active' order by created_at limit 1
$$;
revoke execute on function public._me_at(uuid) from public, anon, authenticated;

create or replace function public._overlaps(p_emp uuid, p_shift public.shifts) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shifts s where s.employee_id = p_emp and s.id <> p_shift.id
                 and s.starts_at < p_shift.ends_at and s.ends_at > p_shift.starts_at)
$$;
revoke execute on function public._overlaps(uuid, public.shifts) from public, anon, authenticated;

-- Offer one of my upcoming published shifts to coworkers.
create or replace function public.shift_offer(p_shift uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s shifts; me employees; rid uuid;
begin
  select * into s from shifts where id = p_shift;
  if s.id is null or not can_access_hotel(s.hotel_id) then raise exception 'Shift not found'; end if;
  me := _me_at(s.hotel_id);
  if me.id is null or s.employee_id is distinct from me.id then raise exception 'You can only offer your own shifts'; end if;
  if not s.published then raise exception 'This shift is not published yet'; end if;
  if s.starts_at <= now() then raise exception 'This shift has already started'; end if;
  if exists (select 1 from shift_requests where shift_id = s.id and status in ('open','claimed')) then raise exception 'This shift is already up for grabs'; end if;
  insert into shift_requests(tenant_id, hotel_id, shift_id, kind, from_employee, status, note)
    values (s.tenant_id, s.hotel_id, s.id, 'giveaway', me.id, 'open', left(p_note, 300)) returning id into rid;
  return rid;
end $$;

-- Claim a coworker's offered shift (goes to a manager for approval).
create or replace function public.shift_claim(p_request uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r shift_requests; s shifts; me employees;
begin
  select * into r from shift_requests where id = p_request for update;
  if r.id is null or not can_access_hotel(r.hotel_id) then raise exception 'Request not found'; end if;
  if r.status <> 'open' then raise exception 'Someone has already claimed this shift'; end if;
  select * into s from shifts where id = r.shift_id;
  me := _me_at(r.hotel_id);
  if me.id is null then raise exception 'You need an employee profile at this hotel to take shifts'; end if;
  if me.id = r.from_employee then raise exception 'This is your own shift'; end if;
  if s.starts_at <= now() then raise exception 'This shift has already started'; end if;
  if _overlaps(me.id, s) then raise exception 'You already have a shift at that time'; end if;
  update shift_requests set to_employee = me.id, status = 'claimed' where id = r.id;
  return 'claimed';
end $$;

-- Ask to pick up an open (unassigned) published shift.
create or replace function public.shift_pickup(p_shift uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare s shifts; me employees; rid uuid;
begin
  select * into s from shifts where id = p_shift;
  if s.id is null or not can_access_hotel(s.hotel_id) then raise exception 'Shift not found'; end if;
  if s.employee_id is not null then raise exception 'This shift is already assigned'; end if;
  if not s.published or s.starts_at <= now() then raise exception 'This shift is not available'; end if;
  me := _me_at(s.hotel_id);
  if me.id is null then raise exception 'You need an employee profile at this hotel to take shifts'; end if;
  if _overlaps(me.id, s) then raise exception 'You already have a shift at that time'; end if;
  if exists (select 1 from shift_requests where shift_id = s.id and status in ('open','claimed')) then raise exception 'Someone has already asked for this shift'; end if;
  insert into shift_requests(tenant_id, hotel_id, shift_id, kind, to_employee, status)
    values (s.tenant_id, s.hotel_id, s.id, 'pickup', me.id, 'claimed') returning id into rid;
  return rid;
end $$;

-- Withdraw my offer or my claim.
create or replace function public.shift_request_cancel(p_request uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r shift_requests; me employees;
begin
  select * into r from shift_requests where id = p_request for update;
  if r.id is null or not can_access_hotel(r.hotel_id) then raise exception 'Request not found'; end if;
  if r.status not in ('open','claimed') then raise exception 'This request is already %', r.status; end if;
  me := _me_at(r.hotel_id);
  if me.id is not null and me.id = r.from_employee then
    update shift_requests set status = 'cancelled' where id = r.id;            -- giver withdraws the whole offer
  elsif me.id is not null and me.id = r.to_employee then
    if r.kind = 'pickup' then update shift_requests set status = 'cancelled' where id = r.id;
    else update shift_requests set status = 'open', to_employee = null where id = r.id; end if;   -- claimer backs out; offer stays open
  else
    raise exception 'Only the people involved can withdraw this';
  end if;
  return 'cancelled';
end $$;

-- Manager decision. Approving moves the shift to the new person.
create or replace function public.shift_request_decide(p_request uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r shift_requests; s shifts;
begin
  select * into r from shift_requests where id = p_request for update;
  if r.id is null or not can_access_hotel(r.hotel_id) or perm_level(r.tenant_id, 'workforce') < 2 then raise exception 'Only schedule managers can approve shift changes'; end if;
  if r.status <> 'claimed' then raise exception 'Nobody has claimed this shift yet'; end if;
  select * into s from shifts where id = r.shift_id for update;
  if p_approve then
    if s.starts_at <= now() then raise exception 'This shift has already started'; end if;
    if r.kind = 'giveaway' and s.employee_id is distinct from r.from_employee then raise exception 'The schedule changed since this was requested. Decline it and ask them to request again.'; end if;
    if r.kind = 'pickup' and s.employee_id is not null then raise exception 'This shift was assigned in the meantime'; end if;
    if _overlaps(r.to_employee, s) then raise exception 'The new person now has another shift at that time'; end if;
    update shifts set employee_id = r.to_employee where id = s.id;
  end if;
  update shift_requests set status = case when p_approve then 'approved' else 'declined' end, decided_by = auth.uid(), decided_at = now(), decision_note = left(p_note, 300) where id = r.id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (r.tenant_id, auth.uid(), case when p_approve then 'approve' else 'decline' end, 'shift_request', r.id::text, jsonb_build_object('shift', s.id, 'from', r.from_employee, 'to', r.to_employee));
  return case when p_approve then 'approved' else 'declined' end;
end $$;

revoke execute on function public.shift_offer(uuid, text), public.shift_claim(uuid), public.shift_pickup(uuid), public.shift_request_cancel(uuid), public.shift_request_decide(uuid, boolean, text) from public, anon;
grant execute on function public.shift_offer(uuid, text), public.shift_claim(uuid), public.shift_pickup(uuid), public.shift_request_cancel(uuid), public.shift_request_decide(uuid, boolean, text) to authenticated;
