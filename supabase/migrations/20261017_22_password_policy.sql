-- Password policy: at least 8 characters with an uppercase letter, a lowercase letter, a number and a special
-- character, and never a password the person has used before. Passwords are set through the set-password function,
-- which checks the rules and compares the new password against the saved hashes of earlier ones (bcrypt; the plain
-- password is never stored). Only hashes are kept, in a schema the API does not expose.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.password_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists password_history_user on private.password_history(user_id, created_at desc);
revoke all on private.password_history from public, anon, authenticated;

-- every password a user gets (sign-up, reset, change) is remembered
create or replace function private._remember_password() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.encrypted_password is not null and new.encrypted_password <> ''
     and (tg_op = 'INSERT' or new.encrypted_password is distinct from old.encrypted_password)
     and not exists (select 1 from private.password_history h where h.user_id = new.id and h.hash = new.encrypted_password) then
    insert into private.password_history(user_id, hash) values (new.id, new.encrypted_password);
  end if;
  return new;
end $$;

create trigger on_auth_user_password
  after insert or update of encrypted_password on auth.users
  for each row execute function private._remember_password();

-- passwords people have today count as used
insert into private.password_history(user_id, hash)
select id, encrypted_password from auth.users u
where coalesce(encrypted_password, '') <> ''
  and not exists (select 1 from private.password_history h where h.user_id = u.id and h.hash = u.encrypted_password);

-- the rules, in one place (also mirrored in the web app for live hints)
create or replace function private.password_problems(p text) returns text[]
language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when length(p) < 8 then 'at least 8 characters' end,
    case when p !~ '[A-Z]' then 'an uppercase letter' end,
    case when p !~ '[a-z]' then 'a lowercase letter' end,
    case when p !~ '[0-9]' then 'a number' end,
    case when p !~ '[^A-Za-z0-9]' then 'a special character' end
  ], null)
$$;

-- used by the set-password function (service role only): has this person used this password before?
create or replace function public.password_was_used(p_user uuid, p_password text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from (
      select hash from private.password_history where user_id = p_user
      union select encrypted_password from auth.users where id = p_user
    ) h
    where h.hash like '$2%' and extensions.crypt(p_password, h.hash) = h.hash
  )
$$;
create or replace function public.password_problems(p_password text) returns text[]
language sql immutable security definer set search_path = '' as $$ select private.password_problems(p_password) $$;

revoke all on function public.password_was_used(uuid, text) from public, anon, authenticated;
revoke all on function public.password_problems(text) from public, anon, authenticated;
grant execute on function public.password_was_used(uuid, text) to service_role;
grant execute on function public.password_problems(text) to service_role;
revoke all on function private._remember_password() from public, anon, authenticated;
