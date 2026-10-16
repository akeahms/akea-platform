-- Platform costs: what the software itself costs to build and run (hosting, database, AI, bank feeds, email, app stores…).
-- Owner-only by default (module "platform_costs", Principal role); grant it to other roles in Users & Permissions.
-- Invoices arrive three ways: pulled from the provider's API (Anthropic cost report), read from invoice emails forwarded
-- to the billing address (inbound-email function), or entered/uploaded by hand.

create table if not exists public.platform_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  category text not null default 'Other',          -- Database, Hosting, AI, Bank feeds, Accounting, Email, Mobile, Domain, Code, Build tools, Other
  purpose text,                                    -- what the platform uses it for
  plan text,
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'annual', 'usage', 'one_time', 'free')),
  expected_amount numeric(12,2),                   -- what you expect per cycle (your number; invoices are the actual)
  phase text not null default 'run' check (phase in ('build', 'run', 'both')),
  feed text not null default 'email' check (feed in ('api', 'email', 'manual')),
  match_terms text[] not null default '{}',        -- sender domains / words that identify this service's invoice emails
  website text,
  started_on date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists public.platform_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  service_id uuid references public.platform_services(id) on delete set null,
  invoice_no text,
  invoice_date date not null,
  period_month date not null,                      -- first day of the month the cost belongs to
  amount numeric(12,2) not null,
  currency text not null default 'USD',
  status text not null default 'paid' check (status in ('paid', 'due', 'accruing', 'review')),
  source text not null default 'manual' check (source in ('api', 'email', 'manual', 'upload')),
  external_key text not null,                      -- de-duplicates the same invoice arriving twice
  file_path text,
  from_address text,
  subject text,
  note text,
  confidence numeric(3,2),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_key)
);
create index if not exists platform_invoices_month on public.platform_invoices(tenant_id, period_month);

create table if not exists public.platform_cost_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  billing_email text unique,                       -- forward invoice emails here
  anthropic_last_sync timestamptz,
  anthropic_last_error text,
  updated_at timestamptz not null default now()
);

alter table public.platform_services enable row level security;
alter table public.platform_invoices enable row level security;
alter table public.platform_cost_settings enable row level security;

create policy platform_services_read on public.platform_services for select to authenticated
  using (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 1);
create policy platform_services_write on public.platform_services for all to authenticated
  using (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 2)
  with check (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 2);
create policy platform_invoices_read on public.platform_invoices for select to authenticated
  using (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 1);
create policy platform_invoices_write on public.platform_invoices for all to authenticated
  using (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 2)
  with check (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 2);
create policy platform_cost_settings_read on public.platform_cost_settings for select to authenticated
  using (tenant_id in (select my_tenant_ids()) and perm_level(tenant_id, 'platform_costs') >= 1);

-- the permission: Principal only, by default (same pattern as Ask AI)
insert into public.role_permissions(role_id, module, level)
select id, 'platform_costs', 'admin' from public.roles where key = 'principal'
on conflict (role_id, module) do nothing;
create or replace function public._principal_platform_costs() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.role_permissions(role_id, module, level) values (new.id, 'platform_costs', 'admin') on conflict (role_id, module) do nothing;
  return new;
end $$;
revoke execute on function public._principal_platform_costs() from public, anon, authenticated;
create trigger roles_principal_platform_costs after insert on public.roles for each row when (new.key = 'principal') execute function public._principal_platform_costs();

-- usage counters the platform already knows (to explain usage-based bills); no prices are assumed
create or replace function public.platform_usage(p_tenant uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', p_month)::date; m1 date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if p_tenant not in (select my_tenant_ids()) or perm_level(p_tenant, 'platform_costs') < 1 then raise exception 'Platform costs needs the Platform costs permission'; end if;
  return jsonb_build_object(
    'ai_questions', (select coalesce(sum(u.questions), 0) from ai_usage u join memberships m on m.user_id = u.user_id and m.tenant_id = p_tenant where u.day >= m0 and u.day < m1),
    'bank_feeds', (select count(*) from bank_connections c join bank_accounts b on b.id = c.bank_account_id where b.tenant_id = p_tenant and c.status in ('active', 'needs_relogin', 'error')),
    'quickbooks_hotels', (select count(*) from qbo_connections where tenant_id = p_tenant),
    'emails_received', (select count(*) from inbound_emails where tenant_id = p_tenant and received_at >= m0 and received_at < m1),
    'hotels', (select count(*) from hotels where tenant_id = p_tenant),
    'users', (select count(distinct user_id) from memberships where tenant_id = p_tenant)
  );
end $$;
revoke execute on function public.platform_usage(uuid, date) from public, anon;
grant execute on function public.platform_usage(uuid, date) to authenticated;

-- invoice files under <tenant>/platform-costs/ are visible only with the Platform costs permission
create policy vault_platform_costs_only on storage.objects as restrictive for select to authenticated using (
  bucket_id <> 'vault' or coalesce((storage.foldername(name))[2], '') <> 'platform-costs'
  or public.perm_level(((storage.foldername(name))[1])::uuid, 'platform_costs') >= 1
);
create policy vault_platform_costs_write on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'vault' or coalesce((storage.foldername(name))[2], '') <> 'platform-costs'
  or public.perm_level(((storage.foldername(name))[1])::uuid, 'platform_costs') >= 2
);

-- billing address and the services this platform runs on (amounts are left for real invoices to fill)
insert into public.platform_cost_settings(tenant_id, billing_email)
select id, 'billing@akeahms.com' from public.tenants where slug = 'akea' on conflict (tenant_id) do nothing;
-- (service list: see migration history "platform_costs_2_services"; inserted for the akea tenant only)

-- morning pull of Anthropic costs (secret token generated in the database, never in git)
insert into public.app_config(key, value)
select 'platform_job_token', encode(extensions.gen_random_bytes(24), 'hex')
where not exists (select 1 from public.app_config where key = 'platform_job_token');
select cron.schedule('akea-platform-costs', '20 12 * * *', $job$
  select net.http_post(
    url := 'https://rqyvjloptxdfojaxjirq.supabase.co/functions/v1/platform-costs?action=sync_all',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-akea-token', (select value from public.app_config where key = 'platform_job_token')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$job$);
