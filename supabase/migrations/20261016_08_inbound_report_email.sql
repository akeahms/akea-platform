-- Nightly PMS reports arrive by email at a per-hotel address (e.g. hampton-cleburne@reports.akeahms.com).
-- (Applied to the live project as migration "inbound_report_email"; addresses were then tidied by hand:
--  laquinta-bedford, hgi-fort-worth, atwell-dfw.)
alter table public.tenants add column if not exists report_domain text default 'reports.akeahms.com';
create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  hotel_id uuid references public.hotels(id) on delete set null,
  to_address text, from_address text, subject text,
  received_at timestamptz not null default now(),
  attachments int not null default 0, reports_created int not null default 0,
  status text not null default 'received' check (status in ('received','processed','partial','unmatched','failed')),
  detail text
);
create index if not exists inbound_emails_tenant on public.inbound_emails(tenant_id, received_at desc);
alter table public.inbound_emails enable row level security;
create policy inbound_emails_read on public.inbound_emails for select to authenticated using (
  tenant_id in (select public.my_tenant_ids()) and public.perm_level(tenant_id, 'reports') >= 1
  and (hotel_id is null or public.can_access_hotel(hotel_id)));
create unique index if not exists hotels_report_email_unique on public.hotels(lower(report_email)) where report_email is not null;
-- _ingest_report (core), ingest_report (user, checks permissions), ingest_report_system (service role only):
-- see the live definitions; ingest_report now delegates to _ingest_report after its permission check.
