-- PIN hashes are never readable from the API; expose only whether a PIN is set.
alter table public.employees add column if not exists has_pin boolean generated always as (pin_hash is not null) stored;
revoke select, insert, update on public.employees from authenticated, anon;
grant select (id, tenant_id, hotel_id, user_id, first_name, last_name, email, phone, department_id, position, employment_type, status, hire_date, data_source, created_at, has_pin)
  on public.employees to authenticated;
grant insert (tenant_id, hotel_id, user_id, first_name, last_name, email, phone, department_id, position, employment_type, status, hire_date)
  on public.employees to authenticated;
grant update (user_id, first_name, last_name, email, phone, department_id, position, employment_type, status, hire_date)
  on public.employees to authenticated;
