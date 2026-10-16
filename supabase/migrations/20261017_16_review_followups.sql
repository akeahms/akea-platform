-- Review follow-ups: manual journal idempotency, QuickBooks company memory, white-label product name + public branding.

-- posting the same manual entry twice (double click, retry) returns the first one
do $$
declare def text;
begin
  def := pg_get_functiondef('public.post_journal(uuid, date, text, jsonb, text, uuid)'::regprocedure);
  def := replace(def, '  insert into journal_entries(tenant_id, hotel_id, entry_date, memo, source, source_id)',
    '  if p_source_id is not null then
    select id into jid from journal_entries where hotel_id = p_hotel and source = p_source and source_id = p_source_id limit 1;
    if jid is not null and p_source = ''manual'' then return jid; end if;
    jid := null;
  end if;
  insert into journal_entries(tenant_id, hotel_id, entry_date, memo, source, source_id)');
  if position('return jid; end if;' in def) = 0 then raise exception 'post_journal did not match'; end if;
  execute def;
end $$;

-- which QuickBooks company a hotel last used (mappings are cleared only when it changes)
alter table public.qbo_settings add column if not exists realm_id text;
update public.qbo_settings s set realm_id = c.realm_id from public.qbo_connections c where c.hotel_id = s.hotel_id and s.realm_id is null;

-- white-label product name (Akea: "Akea AI Suite"); the main domain, no subdomains
alter table public.tenants add column if not exists product_name text;
update public.tenants set product_name = 'Akea AI Suite', custom_domain = 'akeahms.com' where slug = 'akea';
create or replace function public.public_branding(p_host text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', t.name, 'brand_name', t.brand_name, 'product_name', coalesce(t.product_name, t.brand_name, t.name),
                            'logo_url', t.logo_url, 'accent_color', t.accent_color)
  from public.tenants t
  where lower(t.custom_domain) = lower(regexp_replace(coalesce(p_host, ''), '^www\.', ''))
  limit 1
$$;
revoke execute on function public.public_branding(text) from public;
grant execute on function public.public_branding(text) to anon, authenticated;
