-- QuickBooks Online: one connection per hotel (each hotel's books usually live in their own QuickBooks company).
-- Akea pushes: the daily revenue journal from the night audit, approved bills (+ vendors), bill payments, manual journal entries.
-- Tokens are server-only. Mapping, settings and the sync log are readable by finance users.

create table if not exists public.qbo_connections (
  hotel_id uuid primary key references public.hotels(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  realm_id text not null, company_name text,
  access_token text, refresh_token text, access_expires_at timestamptz, refresh_expires_at timestamptz,
  status text not null default 'active' check (status in ('active','needs_relogin','error')),
  last_error text, last_synced_at timestamptz, connected_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.qbo_connections enable row level security;            -- server only
revoke all on public.qbo_connections from anon, authenticated;

create table if not exists public.qbo_oauth_states (
  state text primary key, hotel_id uuid not null references public.hotels(id) on delete cascade, user_id uuid not null,
  return_to text, created_at timestamptz not null default now()
);
alter table public.qbo_oauth_states enable row level security;           -- server only
revoke all on public.qbo_oauth_states from anon, authenticated;

-- what each hotel sends, and from which date (nothing older is ever pushed)
create table if not exists public.qbo_settings (
  hotel_id uuid primary key references public.hotels(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  start_date date not null default current_date,
  push_daily_revenue boolean not null default true,
  push_bills boolean not null default true,
  push_payments boolean not null default true,
  push_journals boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.qbo_settings enable row level security;
create policy qbo_settings_read on public.qbo_settings for select to authenticated using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 1);
create policy qbo_settings_write on public.qbo_settings for all to authenticated
  using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 3) with check (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 3);

-- QuickBooks chart of accounts (cached for the mapping screen)
create table if not exists public.qbo_accounts (
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  qbo_id text not null, name text not null, full_name text, acct_num text, account_type text, account_subtype text, active boolean not null default true,
  primary key (hotel_id, qbo_id)
);
alter table public.qbo_accounts enable row level security;
create policy qbo_accounts_read on public.qbo_accounts for select to authenticated using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 1);
revoke insert, update, delete on public.qbo_accounts from anon, authenticated;

-- Akea account → QuickBooks account, per hotel
create table if not exists public.qbo_account_map (
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  gl_account_id uuid not null references public.gl_accounts(id) on delete cascade,
  qbo_account_id text not null,
  updated_at timestamptz not null default now(),
  primary key (hotel_id, gl_account_id)
);
alter table public.qbo_account_map enable row level security;
create policy qbo_map_read on public.qbo_account_map for select to authenticated using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 1);
create policy qbo_map_write on public.qbo_account_map for all to authenticated
  using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 3) with check (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 3);

create table if not exists public.qbo_vendor_map (
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  qbo_vendor_id text not null,
  primary key (hotel_id, vendor_id)
);
alter table public.qbo_vendor_map enable row level security;             -- server writes; finance can read
create policy qbo_vendor_map_read on public.qbo_vendor_map for select to authenticated
  using (can_access_hotel(hotel_id) and perm_level((select tenant_id from hotels where id = hotel_id), 'finance') >= 1);
revoke insert, update, delete on public.qbo_vendor_map from anon, authenticated;

-- one row per thing sent; the unique key makes every push happen at most once
create table if not exists public.qbo_sync_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  object_type text not null check (object_type in ('daily_revenue','bill','bill_payment','journal')),
  object_key text not null, label text, amount numeric(14,2),
  status text not null check (status in ('synced','failed','needs_mapping')),
  qbo_id text, error text, attempts int not null default 1,
  updated_at timestamptz not null default now(),
  unique (hotel_id, object_type, object_key)
);
create index if not exists qbo_sync_log_hotel on public.qbo_sync_log(hotel_id, updated_at desc);
alter table public.qbo_sync_log enable row level security;
create policy qbo_log_read on public.qbo_sync_log for select to authenticated using (can_access_hotel(hotel_id) and perm_level(tenant_id, 'finance') >= 1);
revoke insert, update, delete on public.qbo_sync_log from anon, authenticated;

-- what the portal may show about a connection (never tokens)
create or replace function public.qbo_status(p_hotels uuid[] default null)
returns table (hotel_id uuid, realm_id text, company_name text, status text, last_error text, last_synced_at timestamptz, refresh_expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.hotel_id, c.realm_id, c.company_name, c.status, c.last_error, c.last_synced_at, c.refresh_expires_at
  from public.qbo_connections c
  where (p_hotels is null or c.hotel_id = any(p_hotels)) and public.can_access_hotel(c.hotel_id) and public.perm_level(c.tenant_id, 'finance') >= 1
$$;
revoke execute on function public.qbo_status(uuid[]) from public, anon;
grant execute on function public.qbo_status(uuid[]) to authenticated;

-- nightly push at 6:45 AM US Central (11:45 UTC), after night audits and bank feeds
insert into public.app_config(key, value)
select 'qbo_job_token', encode(extensions.gen_random_bytes(24), 'hex')
where not exists (select 1 from public.app_config where key = 'qbo_job_token');
select cron.schedule('akea-qbo-sync', '45 11 * * *', $job$
  select net.http_post(
    url := 'https://rqyvjloptxdfojaxjirq.supabase.co/functions/v1/quickbooks?action=sync_all',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-akea-token', (select value from public.app_config where key = 'qbo_job_token')),
    body := '{}'::jsonb, timeout_milliseconds := 120000)
$job$);
