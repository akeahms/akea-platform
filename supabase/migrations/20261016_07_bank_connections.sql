-- Bank-feed tokens: readable only by the server function (service role). No API access for signed-in users.
create table if not exists public.bank_connections (
  bank_account_id uuid primary key references public.bank_accounts(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider in ('plaid','finicity')),
  item_id text, access_token text, external_account_id text, customer_id text, cursor text, institution text,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.bank_connections enable row level security;
revoke all on public.bank_connections from anon, authenticated;
alter table public.reports add column if not exists extracted_notes text[];
