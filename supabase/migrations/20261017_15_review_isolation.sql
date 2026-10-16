-- Review fixes: file access, invitations, policy gaps, RLS performance. Also the single report inbox per company.

-- night-audit files: only people who can see that report row; uploading needs reports edit
alter policy reports_files_read on storage.objects using (
  bucket_id = 'reports' and ((storage.foldername(name))[1])::uuid in (select public.my_tenant_ids())
  and exists (select 1 from public.reports r where r.file_path = objects.name)
);
alter policy reports_files_write on storage.objects with check (
  bucket_id = 'reports' and ((storage.foldername(name))[1])::uuid in (select public.my_tenant_ids())
  and public.perm_level(((storage.foldername(name))[1])::uuid, 'reports') >= 2
);
-- vault files: a record can only point at a file in its own company's folder; access follows that record
alter table public.documents add constraint documents_path_tenant check (file_path is null or split_part(file_path, '/', 1) = tenant_id::text);
alter table public.bills add constraint bills_path_tenant check (file_path is null or split_part(file_path, '/', 1) = tenant_id::text);
alter table public.platform_invoices add constraint platform_invoices_path_tenant check (file_path is null or split_part(file_path, '/', 1) = tenant_id::text);
alter policy vault_read on storage.objects using (
  bucket_id = 'vault' and ((storage.foldername(name))[1])::uuid in (select public.my_tenant_ids())
  and (owner = (select auth.uid())
       or exists (select 1 from public.documents d where d.file_path = objects.name)
       or exists (select 1 from public.bills b where b.file_path = objects.name)
       or exists (select 1 from public.platform_invoices p where p.file_path = objects.name))
);

-- invitations are accepted only once the email address is confirmed
create or replace function public._accept_invites(p_user uuid, p_email text) returns void language plpgsql security definer set search_path = public as $$
declare i record; mid uuid; rid uuid;
begin
  for i in select * from public.invites where lower(email) = lower(p_email) and accepted_at is null loop
    select id into rid from public.roles where tenant_id = i.tenant_id and key = i.role_key;
    if rid is null then continue; end if;
    insert into public.memberships(user_id, tenant_id, role_id, all_hotels)
      values (p_user, i.tenant_id, rid, i.all_hotels)
      on conflict (user_id, tenant_id) do update set role_id = excluded.role_id, all_hotels = excluded.all_hotels
      returning id into mid;
    insert into public.membership_hotels(membership_id, hotel_id) select mid, unnest(i.hotel_ids) on conflict do nothing;
    update public.invites set accepted_at = now() where id = i.id;
  end loop;
end $$;
revoke execute on function public._accept_invites(uuid, text) from public, anon, authenticated;
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id, full_name, email)
    values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), new.email)
    on conflict (user_id) do update set email = excluded.email;
  if new.email_confirmed_at is not null then perform public._accept_invites(new.id, new.email); end if;
  return new;
end $$;
create or replace function public.handle_user_confirmed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then perform public._accept_invites(new.id, new.email); end if;
  return new;
end $$;
revoke execute on function public.handle_user_confirmed() from public, anon, authenticated;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users for each row execute function public.handle_user_confirmed();

-- policy gaps
alter policy reports_update on public.reports with check (((hotel_id is null) or public.can_access_hotel(hotel_id)) and public.perm_level(tenant_id, 'reports') >= 2);
alter policy hotels_write on public.hotels using (public.perm_level(tenant_id, 'settings') >= 4 and public.can_access_hotel(id));
alter policy documents_read on public.documents using (
  tenant_id in (select public.my_tenant_ids()) and ((hotel_id is null) or public.can_access_hotel(hotel_id)) and (
    (public.perm_level(tenant_id, case when folder = 'construction' then 'construction' when folder = any (array['financials', 'loan', 'tax']) then 'finance' else 'compliance' end) >= 1
      and (investor_id is null or public.perm_level(tenant_id, 'investor') >= 2))
    or (visibility = 'investor' and public.perm_level(tenant_id, 'investor') >= 1
      and (investor_id is null or public.perm_level(tenant_id, 'investor') >= 2 or investor_id in (select i.id from public.investors i where i.user_id = (select auth.uid()))))
  )
);
alter table public.roles add constraint roles_id_tenant_uk unique (id, tenant_id);
alter table public.memberships add constraint memberships_role_tenant_fk foreign key (role_id, tenant_id) references public.roles(id, tenant_id);
create or replace function public._guard_principal_grant() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon')
     and exists (select 1 from public.roles r where r.id = new.role_id and r.key = 'principal')
     and (tg_op = 'INSERT' or new.role_id is distinct from old.role_id)
     and not exists (select 1 from public.memberships m join public.roles r on r.id = m.role_id
                     where m.user_id = auth.uid() and m.tenant_id = new.tenant_id and r.key = 'principal') then
    raise exception 'Only a Principal can give someone the Principal / CEO role.';
  end if;
  return new;
end $$;
revoke execute on function public._guard_principal_grant() from public, anon, authenticated;
create trigger memberships_guard_principal before insert or update on public.memberships for each row execute function public._guard_principal_grant();
create or replace function public._guard_principal_invite() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and new.role_key = 'principal'
     and not exists (select 1 from public.memberships m join public.roles r on r.id = m.role_id
                     where m.user_id = auth.uid() and m.tenant_id = new.tenant_id and r.key = 'principal') then
    raise exception 'Only a Principal can invite someone as Principal / CEO.';
  end if;
  return new;
end $$;
revoke execute on function public._guard_principal_invite() from public, anon, authenticated;
create trigger invites_guard_principal before insert or update on public.invites for each row execute function public._guard_principal_invite();
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter function public._akea_type(text) set search_path = public;
alter function public._gl_band(text) set search_path = public;

-- RLS performance: auth.uid() evaluated once per query
do $$
declare p record; q text; c text; sql text;
begin
  for p in select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies
           where schemaname = 'public' and (qual ~ 'auth\.uid\(\)' or with_check ~ 'auth\.uid\(\)') loop
    q := regexp_replace(p.qual, '(?<!SELECT )(?<!select )auth\.uid\(\)', '(select auth.uid())', 'g');
    c := regexp_replace(p.with_check, '(?<!SELECT )(?<!select )auth\.uid\(\)', '(select auth.uid())', 'g');
    sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if p.cmd <> 'INSERT' and q is not null then sql := sql || format(' using (%s)', q); end if;
    if p.cmd in ('INSERT', 'UPDATE', 'ALL') and c is not null then sql := sql || format(' with check (%s)', c); end if;
    if sql <> format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename) then execute sql; end if;
  end loop;
end $$;
create index if not exists journal_lines_account on public.journal_lines(account_id);
create index if not exists journal_lines_entry on public.journal_lines(entry_id);
create index if not exists journal_entries_hotel_date on public.journal_entries(hotel_id, entry_date);
create index if not exists journal_entries_source on public.journal_entries(source, source_id);
create index if not exists bank_transactions_hotel on public.bank_transactions(hotel_id);
create index if not exists bank_transactions_account_status on public.bank_transactions(bank_account_id, status);
create index if not exists bills_hotel_status on public.bills(hotel_id, status);
create index if not exists bills_gl on public.bills(gl_account_id);
create index if not exists po_lines_gl on public.po_lines(gl_account_id);
create index if not exists expected_deposits_hotel_status on public.expected_deposits(hotel_id, status, expected_date);
create index if not exists memberships_user on public.memberships(user_id);
create index if not exists memberships_tenant on public.memberships(tenant_id);
create index if not exists membership_hotels_member on public.membership_hotels(membership_id, hotel_id);
create index if not exists shifts_hotel_start on public.shifts(hotel_id, starts_at);
create index if not exists gl_accounts_parent on public.gl_accounts(parent_id);
create index if not exists gl_accounts_template on public.gl_accounts(template_id);

-- one report inbox per company (no subdomains); the hotel is read from the report itself
alter table public.tenants add column if not exists report_inbox text;
create unique index if not exists tenants_report_inbox_unique on public.tenants(lower(report_inbox)) where report_inbox is not null;
update public.tenants set report_inbox = 'reports@akeahms.com', report_domain = 'akeahms.com' where slug = 'akea';
update public.hotels set report_email = null where report_email ilike '%@reports.akeahms.com';
alter table public.inbound_emails add column if not exists message_id text;
create unique index if not exists inbound_emails_message_unique on public.inbound_emails(message_id) where message_id is not null;
alter table public.reports add column if not exists sha256 text;
create unique index if not exists reports_hotel_file_unique on public.reports(hotel_id, sha256) where sha256 is not null;
alter table public.tenants add column if not exists report_senders text[] not null default '{}';
