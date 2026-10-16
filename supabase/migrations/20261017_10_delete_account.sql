-- Delete an account only if it has never been used (otherwise make it inactive at zero balance).
-- Run this in the Supabase SQL Editor (the migration tool blocks statements containing DELETE).
create or replace function public.delete_account(p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare g gl_accounts := public._gl_admin(p_id); copies int;
begin
  if g.system_key is not null then raise exception '"%" is used automatically by the platform and can''t be deleted. You can rename it.', g.full_name; end if;
  if exists (select 1 from gl_accounts where parent_id = g.id) then raise exception '"%" has sub-accounts. Delete or move those first.', g.full_name; end if;
  select count(*) into copies from gl_accounts where template_id = g.id;
  if public._gl_uses(g.id) - copies > 0 then raise exception '"%" has been used, so it can''t be deleted. Make it inactive instead (its balance must be zero).', g.full_name; end if;
  -- hotels keep their own copy of a deleted template account; it just stops being linked to the template
  update gl_accounts set template_id = null where template_id = g.id;
  delete from gl_accounts where id = g.id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (g.tenant_id, auth.uid(), 'delete', 'gl_account', g.id::text, jsonb_build_object('account', g.full_name, 'hotel_copies_kept', copies));
  return g.full_name;
end $$;
revoke execute on function public.delete_account(uuid) from public, anon;
grant execute on function public.delete_account(uuid) to authenticated;
