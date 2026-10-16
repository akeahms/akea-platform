-- Company website on the main domain (akeahms.com) with the suite at /app/:
-- public image bucket, form submissions (contact + job applications), private résumé bucket.

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('site', 'site', true, 10485760, array['image/png','image/jpeg','image/webp','image/svg+xml','image/gif'])
on conflict (id) do nothing;
insert into public.app_config(key, value)
select 'site_import_token', encode(extensions.gen_random_bytes(24), 'hex')
where not exists (select 1 from public.app_config where key = 'site_import_token');

alter table public.tenants add column if not exists site_domains text[] not null default '{}';
alter table public.tenants add column if not exists site_contact_email text;
alter table public.tenants add column if not exists site_careers_email text;
update public.tenants set site_domains = array['akeahms.com', 'www.akeahms.com', 'akea-portal.onrender.com'],
  site_contact_email = 'info@akeahms.com', site_careers_email = 'careers@akeahms.com' where slug = 'akea';

create table if not exists public.website_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('contact', 'application')),
  first_name text, last_name text, phone text, email text not null, message text,
  position text, linkedin text, resume_path text, resume_name text,
  status text not null default 'new' check (status in ('new', 'contacted', 'closed', 'spam')),
  page text, ip_hash text, notified boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists website_submissions_tenant on public.website_submissions(tenant_id, kind, created_at desc);
create index if not exists website_submissions_ip on public.website_submissions(ip_hash, created_at);
alter table public.website_submissions enable row level security;
create policy website_submissions_read on public.website_submissions for select to authenticated using (
  tenant_id in (select public.my_tenant_ids()) and (
    (kind = 'contact' and public.perm_level(tenant_id, 'company') >= 1) or (kind = 'application' and public.perm_level(tenant_id, 'workforce') >= 2)));
create policy website_submissions_update on public.website_submissions for update to authenticated using (
  tenant_id in (select public.my_tenant_ids()) and (
    (kind = 'contact' and public.perm_level(tenant_id, 'company') >= 2) or (kind = 'application' and public.perm_level(tenant_id, 'workforce') >= 2)))
  with check (tenant_id in (select public.my_tenant_ids()));
revoke insert, delete on public.website_submissions from authenticated, anon;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('applicants', 'applicants', false, 5242880, array['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;
create policy applicants_read on storage.objects for select to authenticated using (
  bucket_id = 'applicants' and exists (select 1 from public.website_submissions s where s.resume_path = objects.name)
);
