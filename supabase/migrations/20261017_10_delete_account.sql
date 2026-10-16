-- Delete an account only if it has never been used (otherwise make it inactive at zero balance).
create or replace function public.delete_account(p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare g gl_accounts := public._gl_admin(p_id);
begin
  if g.system_key is not null then raise exception '"%" is used automatically by the platform and can''t be deleted. You can rename it.', g.full_name; end if;
  if exists (select 1 from gl_accounts where parent_id = g.id) then raise exception '"%" has sub-accounts. Delete or move those first.', g.full_name; end if;
  if public._gl_uses(g.id) > 0 then raise exception '"%" has been used, so it can''t be deleted. Make it inactive instead (its balance must be zero).', g.full_name; end if;
  delete from gl_accounts where id = g.id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (g.tenant_id, auth.uid(), 'delete', 'gl_account', g.id::text, jsonb_build_object('account', g.full_name));
  return g.full_name;
end $$;

revoke execute on function public.delete_account(uuid) from public, anon;
grant execute on function public.delete_account(uuid) to authenticated;
