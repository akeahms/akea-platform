-- Chart of accounts: changes need finance approval rights (the owner role's finance level) and go through checked functions.
-- Direct table edits can't deactivate, change the platform's account roles, move an account between charts, or remove one.

create or replace function public._gl_admin(p_id uuid) returns gl_accounts language plpgsql stable security definer set search_path = public as $$
declare g gl_accounts;
begin
  select * into g from gl_accounts where id = p_id;
  if g.id is null or g.tenant_id not in (select my_tenant_ids()) or perm_level(g.tenant_id, 'finance') < 3
     or (g.hotel_id is not null and not can_access_hotel(g.hotel_id)) then raise exception 'Changing the chart of accounts needs finance approval rights for this hotel'; end if;
  return g;
end $$;
revoke execute on function public._gl_admin(uuid) from public, anon, authenticated;

create or replace function public._gl_direct_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if old.active and not new.active then raise exception 'Use "Make inactive" in the chart of accounts (it checks the balance first)'; end if;
    if new.system_key is distinct from old.system_key then raise exception 'The platform''s account roles can''t be changed directly'; end if;
    if new.tenant_id <> old.tenant_id or new.hotel_id is distinct from old.hotel_id then raise exception 'An account can''t be moved to another chart'; end if;
  end if;
  return new;
end $$;
create trigger gl_accounts_direct_guard before update on public.gl_accounts for each row execute function public._gl_direct_guard();
create policy gl_accounts_no_direct_removal on public.gl_accounts as restrictive for delete to authenticated using (false);

create or replace function public.add_account(p_hotel uuid, p_name text, p_qbo_type text, p_detail text default null, p_parent uuid default null,
                                              p_number text default null, p_tenant uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid := coalesce((select tenant_id from hotels where id = p_hotel), p_tenant); par gl_accounts; nid uuid;
begin
  if t is null or t not in (select my_tenant_ids()) or perm_level(t, 'finance') < 3 or (p_hotel is not null and not can_access_hotel(p_hotel)) then
    raise exception 'Changing the chart of accounts needs finance approval rights for this hotel';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Enter a name'; end if;
  if position(':' in p_name) > 0 then raise exception 'A name can''t contain ":" (pick a parent account instead)'; end if;
  if p_parent is not null then
    select * into par from gl_accounts where id = p_parent;
    if par.id is null or par.tenant_id <> t or par.hotel_id is distinct from p_hotel then raise exception 'The parent account must be in the same chart'; end if;
    if not par.active then raise exception 'The parent account "%" is inactive', par.full_name; end if;
  end if;
  if nullif(btrim(p_number), '') is not null and exists (select 1 from gl_accounts x where x.tenant_id = t and x.hotel_id is not distinct from p_hotel and x.number = btrim(p_number)) then
    raise exception 'Account number % is already used in this chart', btrim(p_number);
  end if;
  insert into gl_accounts(tenant_id, hotel_id, parent_id, name, qbo_type, detail_type, number, section, active)
  values (t, p_hotel, p_parent, btrim(p_name), coalesce(nullif(p_qbo_type, ''), coalesce(par.qbo_type, 'Expense')), nullif(btrim(p_detail), ''), nullif(btrim(p_number), ''),
          coalesce(replace(par.full_name, ':', ' › '), coalesce(nullif(p_qbo_type, ''), 'Expense')), true)
  returning id into nid;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (t, auth.uid(), 'create', 'gl_account', nid::text, jsonb_build_object('account', (select full_name from gl_accounts where id = nid)));
  return nid;
exception when unique_violation then
  raise exception 'An account named "%" already exists here', coalesce(par.full_name || ':', '') || btrim(p_name);
end $$;
revoke execute on function public.add_account(uuid, text, text, text, uuid, text, uuid) from public, anon;
grant execute on function public.add_account(uuid, text, text, text, uuid, text, uuid) to authenticated;

do $$
declare def text;
begin
  def := pg_get_functiondef('public.set_account_active(uuid, boolean)'::regprocedure);
  def := replace(def, 'is used automatically by the platform (bank, receivable, payable, tax or default posting) and can''''t be made inactive. You can rename it.',
                      'is used automatically by the platform (night audit, bills, payments or bank postings) and can''''t be made inactive. You can rename it.');
  execute def;
end $$;
