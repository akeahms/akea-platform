-- Stone & Forest brand theme + white-label colours.
--   * dark_color: the company's main dark colour (side menu, primary buttons). Akea: forest #14241F.
--   * logo_light_url: a light version of the logo for dark backgrounds (optional).
--   * Company admins can edit only their branding and contact fields. Plan, hotel limit, report inbox and web
--     addresses (custom_domain, site_domains) are set by the platform, so one company can't claim another
--     company's web address (sign-in branding, website forms) or raise its own plan.

alter table public.tenants add column if not exists dark_color text;
alter table public.tenants add column if not exists logo_light_url text;
alter table public.tenants drop constraint if exists tenants_dark_color_hex;
alter table public.tenants add constraint tenants_dark_color_hex check (dark_color is null or dark_color ~ '^#[0-9A-Fa-f]{6}$');
alter table public.tenants drop constraint if exists tenants_accent_color_hex;
alter table public.tenants add constraint tenants_accent_color_hex check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$') not valid;
alter table public.tenants drop constraint if exists tenants_logo_light_https;
alter table public.tenants add constraint tenants_logo_light_https check (logo_light_url is null or logo_light_url ~* '^https://');
alter table public.tenants drop constraint if exists tenants_product_name_len;
alter table public.tenants add constraint tenants_product_name_len check (product_name is null or char_length(product_name) between 1 and 60) not valid;

revoke update on public.tenants from authenticated, anon;
grant update (brand_name, product_name, accent_color, dark_color, logo_url, logo_light_url, email_sender,
              site_contact_email, site_careers_email, report_senders) on public.tenants to authenticated;

create unique index if not exists tenants_custom_domain_unique on public.tenants(lower(custom_domain)) where custom_domain is not null;

-- sign-in branding: add the theme colours and the light logo
create or replace function public.public_branding(p_host text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', t.name, 'brand_name', t.brand_name, 'product_name', coalesce(t.product_name, t.brand_name, t.name),
                            'logo_url', t.logo_url, 'logo_light_url', t.logo_light_url, 'accent_color', t.accent_color, 'dark_color', t.dark_color)
  from public.tenants t
  where lower(t.custom_domain) = lower(regexp_replace(coalesce(p_host, ''), '^www\.', ''))
     or lower(coalesce(p_host, '')) = any (select lower(d) from unnest(t.site_domains) d)
  limit 1
$$;

-- Akea's own colours from the brand kit
update public.tenants set accent_color = '#9C7A43', dark_color = '#14241F' where slug = 'akea';
