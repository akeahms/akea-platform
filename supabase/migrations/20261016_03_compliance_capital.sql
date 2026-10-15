-- Phase 4: Compliance & capital — document vault, permits, insurance, renewal notifications,
-- investor portal, construction, personal financial statements, report ingestion.

-- new module: construction
insert into public.role_permissions(role_id, module, level)
select r.id, 'construction', v.level from public.roles r
join (values ('principal','admin'),('regional_director','view'),('controller','edit'),('asset_manager','view'),('auditor','view')) v(key, level) on v.key = r.key
on conflict (role_id, module) do nothing;

-- ---------- document vault ----------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid references public.hotels(id) on delete cascade,
  entity_id uuid references public.entities(id) on delete set null,
  investor_id uuid,
  folder text not null default 'other' check (folder in ('legal','tax','insurance','permits','contracts','hr','floor_plans','loan','investor','financials','construction','other')),
  name text not null, file_path text not null unique, file_size bigint, mime text,
  tags text[] not null default '{}', tax_year int, expires_on date,
  visibility text not null default 'internal' check (visibility in ('internal','investor')),
  uploaded_by uuid default auth.uid(), created_at timestamptz not null default now()
);
create index documents_tenant_folder on public.documents(tenant_id, folder);

create table public.permits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  kind text not null, number text, issuer text,
  issued_on date, expires_on date, renewal_lead_days int not null default 60,
  document_id uuid references public.documents(id) on delete set null,
  notes text, data_source text not null default 'live', created_at timestamptz not null default now()
);

create table public.insurance_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid references public.hotels(id) on delete cascade,     -- null = company-wide / blanket
  entity_id uuid references public.entities(id) on delete set null,
  kind text not null, carrier text, broker text, policy_no text,
  effective_on date, expires_on date, premium numeric(14,2), limits text, deductible text,
  renewal_lead_days int not null default 90,
  document_id uuid references public.documents(id) on delete set null,
  notes text, data_source text not null default 'live', created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid references public.hotels(id) on delete cascade,
  module text not null, kind text not null, object_id uuid, threshold int,
  title text not null, body text, link text, due_on date,
  created_at timestamptz not null default now(),
  unique (kind, object_id, threshold)
);
create table public.notification_reads (
  notification_id uuid references public.notifications(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- ---------- investors ----------
create table public.investors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, email text, phone text, user_id uuid references auth.users(id) on delete set null,
  notes text, data_source text not null default 'live', created_at timestamptz not null default now()
);
create table public.investor_holdings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  investor_id uuid not null references public.investors(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  ownership_pct numeric(7,4) not null check (ownership_pct > 0 and ownership_pct <= 100),
  capital_contributed numeric(14,2) not null default 0,
  unique (investor_id, hotel_id)
);
create table public.distributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  investor_id uuid not null references public.investors(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  paid_on date not null, amount numeric(14,2) not null, memo text,
  data_source text not null default 'live', created_at timestamptz not null default now()
);
alter table public.documents add constraint documents_investor_fk foreign key (investor_id) references public.investors(id) on delete set null;

-- ---------- construction ----------
create table public.construction_budget (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  category text not null, line text not null,
  budget numeric(14,2) not null default 0, committed numeric(14,2) not null default 0, spent numeric(14,2) not null default 0,
  sort int not null default 0, data_source text not null default 'live'
);
create table public.construction_draws (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  draw_no int not null, requested_on date not null, amount numeric(14,2) not null,
  status text not null default 'requested' check (status in ('draft','requested','inspected','funded','rejected')),
  lender text, funded_on date, notes text, data_source text not null default 'live'
);
create table public.construction_milestones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  name text not null, planned_on date, actual_on date,
  status text not null default 'planned' check (status in ('planned','in_progress','done','late')),
  sort int not null default 0, data_source text not null default 'live'
);
create table public.change_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  co_no int not null, description text not null, amount numeric(14,2) not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_on date not null default current_date, data_source text not null default 'live'
);

-- ---------- personal financial statements (only the owner can ever see theirs) ----------
create table public.pfs_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete set null,
  as_of date not null default current_date, title text not null default 'Personal Financial Statement',
  data jsonb not null default '{}', updated_at timestamptz not null default now()
);
alter table public.pfs_statements enable row level security;
create policy pfs_owner on public.pfs_statements for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- security ----------
select public._std_rls('permits', 'compliance', 'hotel');
select public._std_rls('insurance_policies', 'compliance', 'optional');
select public._std_rls('construction_budget', 'construction', 'hotel');
select public._std_rls('construction_draws', 'construction', 'hotel');
select public._std_rls('construction_milestones', 'construction', 'hotel');
select public._std_rls('change_orders', 'construction', 'hotel');
select public._std_rls('investors', 'investor', 'tenant', 2, false);
select public._std_rls('investor_holdings', 'investor', 'hotel', 2, false);
select public._std_rls('distributions', 'investor', 'hotel', 2, false);
-- investor-module editors see all; an investor sees only their own records
create policy investors_read on public.investors for select to authenticated using (
  (tenant_id in (select public.my_tenant_ids()) and public.perm_level(tenant_id, 'investor') >= 2) or user_id = auth.uid());
create policy holdings_read on public.investor_holdings for select to authenticated using (
  (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'investor') >= 2)
  or investor_id in (select i.id from public.investors i where i.user_id = auth.uid()));
create policy distributions_read on public.distributions for select to authenticated using (
  (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'investor') >= 2)
  or investor_id in (select i.id from public.investors i where i.user_id = auth.uid()));

-- documents: internal docs by module; investor docs to investors of that hotel (K-1s only to their own investor)
alter table public.documents enable row level security;
create policy documents_read on public.documents for select to authenticated using (
  tenant_id in (select public.my_tenant_ids()) and (
    (public.perm_level(tenant_id, case when folder = 'construction' then 'construction' when folder in ('financials','loan','tax') then 'finance' else 'compliance' end) >= 1
      and (hotel_id is null or public.can_access_hotel(hotel_id)))
    or (public.perm_level(tenant_id, 'compliance') >= 1 and (hotel_id is null or public.can_access_hotel(hotel_id)))
    or (visibility = 'investor' and public.perm_level(tenant_id, 'investor') >= 1
        and (hotel_id is null or public.can_access_hotel(hotel_id))
        and (investor_id is null or public.perm_level(tenant_id, 'investor') >= 2
             or investor_id in (select i.id from public.investors i where i.user_id = auth.uid())))));
create policy documents_write on public.documents for all to authenticated using (
  tenant_id in (select public.my_tenant_ids()) and (hotel_id is null or public.can_access_hotel(hotel_id))
  and greatest(public.perm_level(tenant_id, 'compliance'), public.perm_level(tenant_id, 'finance'), public.perm_level(tenant_id, 'investor'), public.perm_level(tenant_id, 'construction')) >= 2)
with check (
  tenant_id in (select public.my_tenant_ids()) and (hotel_id is null or public.can_access_hotel(hotel_id))
  and greatest(public.perm_level(tenant_id, 'compliance'), public.perm_level(tenant_id, 'finance'), public.perm_level(tenant_id, 'investor'), public.perm_level(tenant_id, 'construction')) >= 2);

alter table public.notifications enable row level security;
create policy notifications_read on public.notifications for select to authenticated using (
  tenant_id in (select public.my_tenant_ids()) and (hotel_id is null or public.can_access_hotel(hotel_id)) and public.perm_level(tenant_id, module) >= 1);
alter table public.notification_reads enable row level security;
create policy notification_reads_own on public.notification_reads for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- storage: private vault bucket, files live under <tenant>/... ----------
insert into storage.buckets(id, name, public, file_size_limit) values ('vault', 'vault', false, 52428800) on conflict (id) do nothing;
create policy vault_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'vault' and (storage.foldername(name))[1]::uuid in (select public.my_tenant_ids())
  and greatest(public.perm_level((storage.foldername(name))[1]::uuid, 'compliance'), public.perm_level((storage.foldername(name))[1]::uuid, 'finance'),
               public.perm_level((storage.foldername(name))[1]::uuid, 'investor'), public.perm_level((storage.foldername(name))[1]::uuid, 'construction'),
               public.perm_level((storage.foldername(name))[1]::uuid, 'purchasing')) >= 2);
create policy vault_read on storage.objects for select to authenticated using (
  bucket_id = 'vault' and (
    owner = auth.uid()
    or exists (select 1 from public.documents d where d.file_path = storage.objects.name)
    or exists (select 1 from public.bills b where b.file_path = storage.objects.name)));
create policy vault_delete on storage.objects for delete to authenticated using (
  bucket_id = 'vault' and owner = auth.uid());

-- ---------- renewal & due-date notifications ----------
create or replace function public.refresh_notifications() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; c int;
begin
  -- permits at 90/60/30/7/0 days before expiry (and overdue)
  insert into notifications(tenant_id, hotel_id, module, kind, object_id, threshold, title, body, link, due_on)
  select p.tenant_id, p.hotel_id, 'compliance', 'permit_expiring', p.id, th,
    case when p.expires_on < current_date then p.kind || ' has expired' else p.kind || ' expires in ' || (p.expires_on - current_date) || ' days' end,
    h.name || coalesce(' · No. ' || p.number, '') || ' · ' || coalesce(p.issuer, ''), '#permits', p.expires_on
  from permits p join hotels h on h.id = p.hotel_id,
       unnest(array[90, 60, 30, 7, 0]) th
  where p.expires_on is not null and p.expires_on - current_date <= th
    and th = (select min(x) from unnest(array[90, 60, 30, 7, 0]) x where p.expires_on - current_date <= x)
  on conflict (kind, object_id, threshold) do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into notifications(tenant_id, hotel_id, module, kind, object_id, threshold, title, body, link, due_on)
  select p.tenant_id, p.hotel_id, 'compliance', 'policy_expiring', p.id, th,
    case when p.expires_on < current_date then p.kind || ' insurance has expired' else p.kind || ' insurance renews in ' || (p.expires_on - current_date) || ' days' end,
    coalesce(h.name, 'All hotels') || ' · ' || coalesce(p.carrier, '') || coalesce(' · ' || p.policy_no, ''), '#insurance', p.expires_on
  from insurance_policies p left join hotels h on h.id = p.hotel_id,
       unnest(array[90, 60, 30, 7, 0]) th
  where p.expires_on is not null and p.expires_on - current_date <= th
    and th = (select min(x) from unnest(array[90, 60, 30, 7, 0]) x where p.expires_on - current_date <= x)
  on conflict (kind, object_id, threshold) do nothing;
  get diagnostics c = row_count; n := n + c;
  -- bills due within 3 days that are not yet paid
  insert into notifications(tenant_id, hotel_id, module, kind, object_id, threshold, title, body, link, due_on)
  select b.tenant_id, b.hotel_id, 'finance', 'bill_due', b.id, 3,
    'Bill due ' || to_char(b.due_date, 'Mon DD') || ': ' || coalesce(v.name, 'vendor') || ' $' || to_char(b.amount, 'FM999,999,990.00'),
    h.name || coalesce(' · ' || b.invoice_no, ''), '#bills', b.due_date
  from bills b join hotels h on h.id = b.hotel_id left join vendors v on v.id = b.vendor_id
  where b.status in ('pending_approval','approved','draft') and b.due_date <= current_date + 3
  on conflict (kind, object_id, threshold) do nothing;
  get diagnostics c = row_count; n := n + c;
  -- documents with an expiry date
  insert into notifications(tenant_id, hotel_id, module, kind, object_id, threshold, title, body, link, due_on)
  select d.tenant_id, d.hotel_id, 'compliance', 'document_expiring', d.id, 30, d.name || ' expires ' || to_char(d.expires_on, 'Mon DD, YYYY'), null, '#vault', d.expires_on
  from documents d where d.expires_on is not null and d.expires_on <= current_date + 30
  on conflict (kind, object_id, threshold) do nothing;
  get diagnostics c = row_count; n := n + c;
  return n;
end $$;
revoke execute on function public.refresh_notifications() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.schedule('akea-daily-notifications', '15 11 * * *', 'select public.refresh_notifications()');

-- ---------- report ingestion: values read from an uploaded report become the day's numbers ----------
create or replace function public.ingest_report(p_report uuid, p_values jsonb, p_confidence numeric, p_deposits jsonb default null) returns text
language plpgsql security definer set search_path = public as $$
declare r reports; hrooms int;
begin
  select * into r from reports where id = p_report;
  if r.id is null or r.hotel_id is null or not public.can_access_hotel(r.hotel_id) or public.perm_level(r.tenant_id, 'reports') < 2 then raise exception 'Not allowed'; end if;
  if r.business_date is null then raise exception 'The report needs a business date'; end if;
  select rooms into hrooms from hotels where id = r.hotel_id;
  if (p_values ? 'rooms_sold') or (p_values ? 'room_revenue') then
    insert into daily_metrics(hotel_id, business_date, rooms_available, rooms_sold, out_of_order, comp_rooms, no_shows, arrivals, departures, in_house_guests,
                              room_revenue, fnb_revenue, other_revenue, source_report_id, updated_at, data_source)
    values (r.hotel_id, r.business_date,
      coalesce((p_values->>'rooms_available')::int, hrooms), (p_values->>'rooms_sold')::int, coalesce((p_values->>'out_of_order')::int, 0),
      coalesce((p_values->>'comp_rooms')::int, 0), coalesce((p_values->>'no_shows')::int, 0), coalesce((p_values->>'arrivals')::int, 0),
      coalesce((p_values->>'departures')::int, 0), coalesce((p_values->>'in_house_guests')::int, 0),
      coalesce((p_values->>'room_revenue')::numeric, 0), coalesce((p_values->>'fnb_revenue')::numeric, 0), coalesce((p_values->>'other_revenue')::numeric, 0),
      r.id, now(), 'report')
    on conflict (hotel_id, business_date) do update set
      rooms_available = excluded.rooms_available, rooms_sold = coalesce(excluded.rooms_sold, daily_metrics.rooms_sold),
      out_of_order = excluded.out_of_order, comp_rooms = excluded.comp_rooms, no_shows = excluded.no_shows, arrivals = excluded.arrivals,
      departures = excluded.departures, in_house_guests = excluded.in_house_guests, room_revenue = excluded.room_revenue,
      fnb_revenue = excluded.fnb_revenue, other_revenue = excluded.other_revenue, source_report_id = excluded.source_report_id,
      updated_at = now(), data_source = 'report';
  end if;
  if p_deposits is not null then
    update expected_deposits set status = 'written_off' where report_id = r.id and status = 'open';
    insert into expected_deposits(tenant_id, hotel_id, business_date, source, amount, expected_date, report_id)
    select r.tenant_id, r.hotel_id, r.business_date, d.key, (d.value)::numeric,
           r.business_date + case d.key when 'amex' then 2 when 'ota' then 3 when 'direct_bill' then 20 else 1 end, r.id
    from jsonb_each_text(p_deposits) d where (d.value)::numeric > 0;
  end if;
  update reports set status = case when p_confidence >= 0.8 then 'processed' else 'needs_review' end, confidence = p_confidence where id = r.id;
  return case when p_confidence >= 0.8 then 'processed' else 'needs_review' end;
end $$;
revoke execute on function public.ingest_report(uuid, jsonb, numeric, jsonb) from public, anon;
grant execute on function public.ingest_report(uuid, jsonb, numeric, jsonb) to authenticated;

-- ---------- investor summary (security invoker: investors see only their hotels) ----------
create or replace function public.investor_summary(p_year int default extract(year from current_date)::int)
returns table (investor_id uuid, investor text, hotel_id uuid, hotel text, ownership_pct numeric, capital numeric,
               distributions_ytd numeric, distributions_total numeric)
language sql stable security invoker set search_path = public as $$
  select i.id, i.name, h.id, h.name, ih.ownership_pct, ih.capital_contributed,
    coalesce((select sum(d.amount) from distributions d where d.investor_id = i.id and d.hotel_id = h.id and extract(year from d.paid_on) = p_year), 0),
    coalesce((select sum(d.amount) from distributions d where d.investor_id = i.id and d.hotel_id = h.id), 0)
  from investor_holdings ih join investors i on i.id = ih.investor_id join hotels h on h.id = ih.hotel_id
  order by i.name, h.name
$$;
revoke execute on function public.investor_summary(int) from public, anon;
grant execute on function public.investor_summary(int) to authenticated;
