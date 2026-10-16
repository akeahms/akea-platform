-- Branding for the sign-in page also matches the company's website domains (e.g. the Render host before the
-- custom domain moves), not only its custom app domain.
create or replace function public.public_branding(p_host text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', t.name, 'brand_name', t.brand_name, 'product_name', coalesce(t.product_name, t.brand_name, t.name),
                            'logo_url', t.logo_url, 'accent_color', t.accent_color)
  from public.tenants t
  where lower(t.custom_domain) = lower(regexp_replace(coalesce(p_host, ''), '^www\.', ''))
     or lower(coalesce(p_host, '')) = any (select lower(d) from unnest(t.site_domains) d)
  limit 1
$$;
