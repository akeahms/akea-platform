-- Ask AI is its own permission. Only the Principal (super admin) role has it by default; turn it on for other roles
-- in Users & Permissions → Role permissions. The server enforces it (ai_quota_take), not just the menu.

insert into public.role_permissions(role_id, module, level)
select id, 'ask_ai', 'admin' from public.roles where key = 'principal'
on conflict (role_id, module) do nothing;

-- new companies: their Principal role gets Ask AI too
create or replace function public._principal_ask_ai() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.role_permissions(role_id, module, level) values (new.id, 'ask_ai', 'admin') on conflict (role_id, module) do nothing;
  return new;
end $$;
revoke execute on function public._principal_ask_ai() from public, anon, authenticated;
create trigger roles_principal_ask_ai after insert on public.roles for each row when (new.key = 'principal') execute function public._principal_ask_ai();

-- the Principal role can't be stripped of access from the portal (prevents locking the owner out)
create or replace function public._guard_principal_perms() returns trigger language plpgsql set search_path = public as $$
declare rid uuid := coalesce(old.role_id, new.role_id);
begin
  if current_user in ('authenticated', 'anon') and exists (select 1 from public.roles where id = rid and key = 'principal') then
    raise exception 'The Principal / CEO role always keeps full access.';
  end if;
  return coalesce(new, old);
end $$;
create trigger role_permissions_guard_principal before update or delete on public.role_permissions
  for each row execute function public._guard_principal_perms();

-- Ask AI requires the permission (checked on every question, before any AI call is made)
create or replace function public.ai_quota_take() returns int
language plpgsql security definer set search_path = public as $$
declare lim int; used int;
begin
  if auth.uid() is null or not exists (select 1 from public.my_tenant_ids() t where public.perm_level(t, 'ask_ai') >= 1) then
    raise exception 'Ask AI isn''t turned on for your role. Ask your administrator to enable it in Users & Permissions.';
  end if;
  select coalesce((select value::int from public.app_config where key = 'ai_daily_limit'), 60) into lim;
  insert into public.ai_usage(user_id, day, questions) values (auth.uid(), current_date, 1)
    on conflict (user_id, day) do update set questions = ai_usage.questions + 1
    returning questions into used;
  if used > lim then raise exception 'You''ve reached today''s limit of % Ask AI questions. It resets at midnight UTC.', lim; end if;
  return lim - used;
end $$;
