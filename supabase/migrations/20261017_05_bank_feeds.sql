-- Bank feeds (Plaid, Finicity): connection status, a safe status view for the portal, webhook token and nightly sync.

alter table public.bank_connections
  add column if not exists status text not null default 'active' check (status in ('pending','active','needs_relogin','error','disconnected')),
  add column if not exists last_error text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists account_name text,
  add column if not exists account_mask text,
  add column if not exists consent_expires_at timestamptz;
create index if not exists bank_connections_item on public.bank_connections(item_id);
create index if not exists bank_connections_customer on public.bank_connections(customer_id);

-- What the portal may show about a feed (never tokens). Finance view rights on the hotel are required.
create or replace function public.bank_feed_status(p_accounts uuid[] default null)
returns table (bank_account_id uuid, provider text, status text, institution text, account_name text, account_mask text,
               last_synced_at timestamptz, last_error text, consent_expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.bank_account_id, c.provider, c.status, c.institution, c.account_name, c.account_mask, c.last_synced_at, c.last_error, c.consent_expires_at
  from public.bank_connections c join public.bank_accounts a on a.id = c.bank_account_id
  where (p_accounts is null or c.bank_account_id = any(p_accounts))
    and public.can_access_hotel(a.hotel_id) and public.perm_level(a.tenant_id, 'finance') >= 1
$$;
revoke execute on function public.bank_feed_status(uuid[]) from public, anon;
grant execute on function public.bank_feed_status(uuid[]) to authenticated;

-- Shared secret for the bank webhook and the nightly job (kept in the database, never in git).
insert into public.app_config(key, value)
select 'bank_webhook_token', encode(extensions.gen_random_bytes(24), 'hex')
where not exists (select 1 from public.app_config where key = 'bank_webhook_token');

-- Nightly sync of every connected account at 5:30 AM US Central (10:30 UTC), after night audits arrive.
create extension if not exists pg_net with schema extensions;
select cron.schedule('akea-bank-sync', '30 10 * * *', $job$
  select net.http_post(
    url := 'https://rqyvjloptxdfojaxjirq.supabase.co/functions/v1/bank-feeds?action=sync_all',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-akea-token', (select value from public.app_config where key = 'bank_webhook_token')),
    body := '{}'::jsonb, timeout_milliseconds := 120000)
$job$);
