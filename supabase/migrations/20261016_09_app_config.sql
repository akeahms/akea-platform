-- Server-only settings (read by server functions with the service role; no API access for users).
create table if not exists public.app_config (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
-- the inbound-email webhook token is inserted directly in the live project and is not kept in git
