-- Click-to-accept records for the Terms of Service and the company Subscription Agreement.
-- Each person accepts the user documents once per version; a Principal accepts the company documents for the company.
-- Every acceptance keeps who, what version, when, the IP address and the browser, and can't be edited or deleted.
create table if not exists public.legal_acceptances (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,   -- kept (with email) as evidence even if the user is removed
  tenant_id uuid references public.tenants(id) on delete set null,
  document text not null check (document in ('terms', 'privacy-policy', 'acceptable-use', 'disclaimers', 'subscription-agreement', 'dpa')),
  version text not null,
  on_behalf_of_company boolean not null default false,
  accepted_at timestamptz not null default now(),
  ip text,
  user_agent text,
  email text
);
create index if not exists legal_acceptances_user on public.legal_acceptances(user_id, version);
create index if not exists legal_acceptances_tenant on public.legal_acceptances(tenant_id, document, version);
alter table public.legal_acceptances enable row level security;
create policy legal_acceptances_read on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()) or (tenant_id is not null and public.is_principal(tenant_id)));
revoke insert, update, delete on public.legal_acceptances from anon, authenticated;
grant select on public.legal_acceptances to authenticated;

-- the version people must have accepted (matches web/src/lib/legal.ts and web/site/legal.json)
create or replace function public.legal_version() returns text language sql immutable as $$ select '2026-10-17'::text $$;

create or replace function public.legal_status(p_tenant uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', public.legal_version(),
    'user_accepted', exists (select 1 from public.legal_acceptances a where a.user_id = auth.uid() and a.document = 'terms' and a.version = public.legal_version()),
    'is_principal', p_tenant is not null and public.is_principal(p_tenant),
    'company_accepted', p_tenant is null or exists (select 1 from public.legal_acceptances a where a.tenant_id = p_tenant and a.document = 'subscription-agreement' and a.version = public.legal_version()),
    'company_accepted_by', (select a.email from public.legal_acceptances a where a.tenant_id = p_tenant and a.document = 'subscription-agreement' and a.version = public.legal_version() order by a.accepted_at limit 1)
  )
$$;

create or replace function public.accept_legal(p_version text, p_tenant uuid default null, p_company boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hdr jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  v_ip text := nullif(trim(split_part(coalesce(hdr ->> 'x-forwarded-for', hdr ->> 'x-real-ip', ''), ',', 1)), '');
  v_ua text := left(hdr ->> 'user-agent', 400);
  v_email text := (select u.email from auth.users u where u.id = uid);
  d text;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  if p_version is distinct from public.legal_version() then
    raise exception 'These terms have been updated. Reload the page to see the current version.';
  end if;
  if p_tenant is not null and not exists (select 1 from public.memberships m where m.user_id = uid and m.tenant_id = p_tenant) then
    raise exception 'Not a member of that company';
  end if;
  foreach d in array array['terms', 'privacy-policy', 'acceptable-use', 'disclaimers'] loop
    if not exists (select 1 from public.legal_acceptances a where a.user_id = uid and a.document = d and a.version = p_version) then
      insert into public.legal_acceptances(user_id, tenant_id, document, version, ip, user_agent, email)
      values (uid, p_tenant, d, p_version, v_ip, v_ua, v_email);
    end if;
  end loop;
  if p_company then
    if p_tenant is null or not public.is_principal(p_tenant) then
      raise exception 'Only a Principal can accept the company agreement.';
    end if;
    foreach d in array array['subscription-agreement', 'dpa'] loop
      if not exists (select 1 from public.legal_acceptances a where a.tenant_id = p_tenant and a.document = d and a.version = p_version) then
        insert into public.legal_acceptances(user_id, tenant_id, document, version, on_behalf_of_company, ip, user_agent, email)
        values (uid, p_tenant, d, p_version, true, v_ip, v_ua, v_email);
      end if;
    end loop;
  end if;
  return public.legal_status(p_tenant);
end $$;

revoke all on function public.legal_status(uuid) from public, anon;
revoke all on function public.accept_legal(text, uuid, boolean) from public, anon;
grant execute on function public.legal_status(uuid) to authenticated;
grant execute on function public.accept_legal(text, uuid, boolean) to authenticated;
alter function public.legal_version() set search_path = '';
