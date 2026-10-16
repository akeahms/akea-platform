-- Every hotel keeps its own books. Shared across hotels only: the owner's portfolio dashboard (read-only totals for people
-- given several hotels), the vendor master list, and a company chart-of-accounts / department TEMPLATE that each hotel
-- starts from and then owns. Rows with hotel_id = null in gl_accounts / departments are that template.

-- 1) hotel ownership of accounts and departments
alter table public.gl_accounts add column if not exists hotel_id uuid references public.hotels(id) on delete cascade;
alter table public.departments add column if not exists hotel_id uuid references public.hotels(id) on delete cascade;
alter table public.gl_accounts drop constraint if exists gl_accounts_tenant_id_number_key;
alter table public.departments drop constraint if exists departments_tenant_id_name_key;
create unique index if not exists gl_accounts_scope_number on public.gl_accounts(tenant_id, coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid), number);
create unique index if not exists departments_scope_name on public.departments(tenant_id, coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
create index if not exists gl_accounts_hotel on public.gl_accounts(hotel_id, number);
create index if not exists departments_hotel on public.departments(hotel_id);

-- templates (company level) no longer rely on the dropped constraints
create or replace function public.create_default_gl(t uuid) returns void language sql security definer set search_path = public as $$
  insert into public.gl_accounts(tenant_id, number, name, type, section)
  select t, v.number, v.name, v.type, v.section from (values
  ('1000','Operating Cash','asset','Assets'),('1010','Payroll Cash','asset','Assets'),('1050','Credit Card Clearing','asset','Assets'),
  ('1100','Guest Ledger','asset','Assets'),('1110','Accounts Receivable — Direct Bill','asset','Assets'),('1200','Inventory','asset','Assets'),
  ('1300','Prepaid Expenses','asset','Assets'),('1500','Property & Equipment','asset','Assets'),('1600','FF&E Reserve','asset','Assets'),
  ('2000','Accounts Payable','liability','Liabilities'),('2100','Accrued Payroll','liability','Liabilities'),('2200','Sales & Occupancy Tax Payable','liability','Liabilities'),
  ('2300','Advance Deposits','liability','Liabilities'),('2500','Mortgage Payable','liability','Liabilities'),
  ('3000','Owner Equity','equity','Equity'),('3100','Distributions','equity','Equity'),
  ('4000','Room Revenue','revenue','Rooms'),('4100','Food & Beverage Revenue','revenue','F&B'),('4200','Other Operated Revenue','revenue','Other'),('4300','Miscellaneous Income','revenue','Other'),
  ('5000','Rooms Payroll','expense','Rooms'),('5010','Rooms Supplies & Amenities','expense','Rooms'),('5020','Laundry & Linen','expense','Rooms'),
  ('5030','Travel Agent & OTA Commissions','expense','Rooms'),('5040','Reservation & Brand Fees','expense','Rooms'),
  ('5100','F&B Cost of Sales','expense','F&B'),('5110','F&B Payroll','expense','F&B'),
  ('6000','A&G Payroll','expense','Undistributed — A&G'),('6010','Credit Card Commissions','expense','Undistributed — A&G'),('6020','Professional Fees','expense','Undistributed — A&G'),
  ('6030','Office & Technology','expense','Undistributed — A&G'),('6100','Sales & Marketing','expense','Undistributed — S&M'),('6110','Franchise Marketing Fees','expense','Undistributed — S&M'),
  ('6200','Maintenance Payroll','expense','Undistributed — Maintenance'),('6210','Repairs & Maintenance','expense','Undistributed — Maintenance'),
  ('6300','Electricity','expense','Undistributed — Utilities'),('6310','Gas','expense','Undistributed — Utilities'),('6320','Water & Sewer','expense','Undistributed — Utilities'),
  ('6400','Management Fees','expense','Management Fees'),('6500','Franchise Royalty','expense','Fixed — Franchise'),
  ('7000','Property Taxes','expense','Fixed Charges'),('7010','Insurance','expense','Fixed Charges'),('7100','Interest Expense','expense','Fixed Charges'),
  ('7200','Depreciation','expense','Fixed Charges'),('7300','FF&E Reserve Contribution','expense','Fixed Charges')) as v(number, name, type, section)
  where not exists (select 1 from public.gl_accounts g where g.tenant_id = t and g.hotel_id is null and g.number = v.number);
$$;
create or replace function public.create_default_departments(t uuid) returns void language sql security definer set search_path = public as $$
  insert into public.departments(tenant_id, name, color, sort)
  select t, v.name, v.color, v.sort from (values ('Front Office', '#2F5BD3', 1), ('Housekeeping', '#C0396B', 2), ('Laundry', '#0E8A9A', 3),
    ('Maintenance', '#B7741A', 4), ('Breakfast & F&B', '#2E8B57', 5), ('Night Audit', '#5146C9', 6), ('Sales', '#8E44AD', 7), ('Management', '#8A6A2F', 8)) as v(name, color, sort)
  where not exists (select 1 from public.departments d where d.tenant_id = t and d.hotel_id is null and d.name = v.name);
$$;

-- 2) give a hotel its own copy of the template (missing items only; never overwrites what the hotel changed)
create or replace function public._copy_templates(p_hotel uuid) returns int language plpgsql security definer set search_path = public as $$
declare t uuid; n int; m int;
begin
  select tenant_id into t from hotels where id = p_hotel;
  insert into gl_accounts(tenant_id, hotel_id, number, name, type, section, active)
  select t, p_hotel, g.number, g.name, g.type, g.section, g.active from gl_accounts g
  where g.tenant_id = t and g.hotel_id is null
    and not exists (select 1 from gl_accounts x where x.hotel_id = p_hotel and x.number = g.number);
  get diagnostics n = row_count;
  insert into departments(tenant_id, hotel_id, name, color, sort)
  select t, p_hotel, d.name, d.color, d.sort from departments d
  where d.tenant_id = t and d.hotel_id is null
    and not exists (select 1 from departments x where x.hotel_id = p_hotel and x.name = d.name);
  get diagnostics m = row_count;
  return n + m;
end $$;
revoke execute on function public._copy_templates(uuid) from public, anon, authenticated;

-- portal button: add template accounts/departments a hotel doesn't have yet
create or replace function public.apply_templates(p_hotel uuid) returns int language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null or not can_access_hotel(p_hotel) or greatest(perm_level(t, 'finance'), perm_level(t, 'workforce')) < 4 then raise exception 'Not allowed'; end if;
  return _copy_templates(p_hotel);
end $$;
revoke execute on function public.apply_templates(uuid) from public, anon;
grant execute on function public.apply_templates(uuid) to authenticated;

-- every new hotel starts with its own copy
create or replace function public._hotel_templates() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public._copy_templates(new.id); return new; end $$;
revoke execute on function public._hotel_templates() from public, anon, authenticated;
create trigger hotels_copy_templates after insert on public.hotels for each row execute function public._hotel_templates();

do $$ declare h record; begin for h in select id from hotels loop perform public._copy_templates(h.id); end loop; end $$;

-- 3) translate a template / foreign reference to the hotel's own row (null if it belongs to another hotel)
create or replace function public._hotel_gl(p_hotel uuid, p_gl uuid) returns uuid language sql stable security definer set search_path = public as $$
  select case when g.hotel_id = p_hotel then g.id
              when g.hotel_id is null then (select x.id from gl_accounts x where x.hotel_id = p_hotel and x.number = g.number)
         end
  from gl_accounts g where g.id = p_gl
$$;
create or replace function public._hotel_dept(p_hotel uuid, p_dept uuid) returns uuid language sql stable security definer set search_path = public as $$
  select case when d.hotel_id = p_hotel then d.id
              when d.hotel_id is null then (select x.id from departments x where x.hotel_id = p_hotel and x.name = d.name)
         end
  from departments d where d.id = p_dept
$$;
create or replace function public._gl_h(p_hotel uuid, num text) returns uuid language sql stable security definer set search_path = public as $$
  select id from public.gl_accounts where hotel_id = p_hotel and number = num
$$;
revoke execute on function public._hotel_gl(uuid, uuid), public._hotel_dept(uuid, uuid), public._gl_h(uuid, text) from public, anon, authenticated;

-- 4) move existing records onto each hotel's own accounts and departments
select set_config('akea.approved_path', 'on', true);
update public.bills set gl_account_id = public._hotel_gl(hotel_id, gl_account_id) where gl_account_id is not null and gl_account_id is distinct from public._hotel_gl(hotel_id, gl_account_id);
update public.po_lines set gl_account_id = public._hotel_gl(hotel_id, gl_account_id) where gl_account_id is not null and gl_account_id is distinct from public._hotel_gl(hotel_id, gl_account_id);
update public.journal_lines set account_id = public._hotel_gl(hotel_id, account_id) where account_id is distinct from public._hotel_gl(hotel_id, account_id);
update public.budget_gl set account_id = public._hotel_gl(hotel_id, account_id) where account_id is distinct from public._hotel_gl(hotel_id, account_id);
update public.bank_accounts set gl_account_id = public._hotel_gl(hotel_id, gl_account_id) where gl_account_id is not null and gl_account_id is distinct from public._hotel_gl(hotel_id, gl_account_id);
update public.bank_transactions set gl_account_id = public._hotel_gl(hotel_id, gl_account_id) where gl_account_id is not null and gl_account_id is distinct from public._hotel_gl(hotel_id, gl_account_id);
update public.qbo_account_map set gl_account_id = public._hotel_gl(hotel_id, gl_account_id) where gl_account_id is distinct from public._hotel_gl(hotel_id, gl_account_id);
update public.employees set department_id = public._hotel_dept(hotel_id, department_id) where department_id is not null and department_id is distinct from public._hotel_dept(hotel_id, department_id);
update public.shifts set department_id = public._hotel_dept(hotel_id, department_id) where department_id is not null and department_id is distinct from public._hotel_dept(hotel_id, department_id);
update public.purchase_orders set department_id = public._hotel_dept(hotel_id, department_id) where department_id is not null and department_id is distinct from public._hotel_dept(hotel_id, department_id);

-- 5) the guard: a hotel's records may only point at that hotel's accounts, departments, people, shifts, bank accounts,
--    orders, imports and journal entries. Template accounts/departments are swapped for the hotel's own copy automatically.
create or replace function public._same_hotel() returns trigger language plpgsql security definer set search_path = public as $$
declare i int; col text; tbl text; val uuid; owner uuid; fixed uuid; j jsonb := to_jsonb(new);
begin
  for i in 0 .. tg_nargs - 1 loop
    col := split_part(tg_argv[i], ':', 1); tbl := split_part(tg_argv[i], ':', 2);
    val := nullif(j ->> col, '')::uuid;
    continue when val is null;
    if tbl = 'gl_accounts' then
      fixed := public._hotel_gl(new.hotel_id, val);
      if fixed is null then raise exception 'That account belongs to another hotel''s books (or this hotel has no matching account). Use one of this hotel''s accounts.'; end if;
      if fixed <> val then j := jsonb_set(j, array[col], to_jsonb(fixed)); end if;
    elsif tbl = 'departments' then
      fixed := public._hotel_dept(new.hotel_id, val);
      if fixed is null then raise exception 'That department belongs to another hotel. Use one of this hotel''s departments.'; end if;
      if fixed <> val then j := jsonb_set(j, array[col], to_jsonb(fixed)); end if;
    else
      execute format('select hotel_id from public.%I where id = $1', tbl) into owner using val;
      if owner is distinct from new.hotel_id then raise exception 'Hotels are kept separate: this % belongs to a different hotel.', replace(rtrim(tbl, 's'), '_', ' '); end if;
    end if;
  end loop;
  return jsonb_populate_record(new, j);
end $$;
revoke execute on function public._same_hotel() from public, anon, authenticated;

create trigger bills_same_hotel before insert or update on public.bills for each row execute function public._same_hotel('gl_account_id:gl_accounts', 'po_id:purchase_orders', 'bank_account_id:bank_accounts');
create trigger po_lines_same_hotel before insert or update on public.po_lines for each row execute function public._same_hotel('gl_account_id:gl_accounts', 'po_id:purchase_orders');
create trigger journal_lines_same_hotel before insert or update on public.journal_lines for each row execute function public._same_hotel('account_id:gl_accounts', 'entry_id:journal_entries');
create trigger budget_gl_same_hotel before insert or update on public.budget_gl for each row execute function public._same_hotel('account_id:gl_accounts');
create trigger bank_accounts_same_hotel before insert or update on public.bank_accounts for each row execute function public._same_hotel('gl_account_id:gl_accounts');
create trigger bank_tx_same_hotel before insert or update on public.bank_transactions for each row execute function public._same_hotel('gl_account_id:gl_accounts', 'bank_account_id:bank_accounts', 'import_id:statement_imports');
create trigger statement_imports_same_hotel before insert or update on public.statement_imports for each row execute function public._same_hotel('bank_account_id:bank_accounts');
create trigger qbo_map_same_hotel before insert or update on public.qbo_account_map for each row execute function public._same_hotel('gl_account_id:gl_accounts');
create trigger employees_same_hotel before insert or update on public.employees for each row execute function public._same_hotel('department_id:departments');
create trigger shifts_same_hotel before insert or update on public.shifts for each row execute function public._same_hotel('department_id:departments', 'employee_id:employees');
create trigger purchase_orders_same_hotel before insert or update on public.purchase_orders for each row execute function public._same_hotel('department_id:departments');
create trigger time_punches_same_hotel before insert or update on public.time_punches for each row execute function public._same_hotel('employee_id:employees', 'shift_id:shifts');
create trigger employee_pay_same_hotel before insert or update on public.employee_pay for each row execute function public._same_hotel('employee_id:employees');
create trigger shift_requests_same_hotel before insert or update on public.shift_requests for each row execute function public._same_hotel('shift_id:shifts', 'from_employee:employees', 'to_employee:employees');

-- 6) who can see a hotel's accounts and departments: only people with access to that hotel (template: company finance/workforce users)
create policy gl_accounts_hotel_only on public.gl_accounts as restrictive for all to authenticated
  using (hotel_id is null or public.can_access_hotel(hotel_id)) with check (hotel_id is null or public.can_access_hotel(hotel_id));
create policy departments_hotel_only on public.departments as restrictive for all to authenticated
  using (hotel_id is null or public.can_access_hotel(hotel_id)) with check (hotel_id is null or public.can_access_hotel(hotel_id));

-- 7) finance functions post to the hotel's own accounts
do $$
declare f record; def text; newdef text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('decide_bill', 'pay_bills', 'auto_reconcile', 'match_transaction') loop
    def := pg_get_functiondef(f.oid);
    newdef := regexp_replace(def, 'public\._gl\((\w+)\.tenant_id,', 'public._gl_h(\1.hotel_id,', 'g');
    if newdef <> def then execute newdef; end if;
  end loop;
end $$;
create or replace function public.post_journal(p_hotel uuid, p_date date, p_memo text, p_lines jsonb, p_source text default 'manual', p_source_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; jid uuid; dr numeric; cr numeric;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null or not public.can_access_hotel(p_hotel) or public.perm_level(t, 'finance') < 2 then raise exception 'Not allowed'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then raise exception 'An entry needs at least two lines'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l
             where public._hotel_gl(p_hotel, (l->>'account_id')::uuid) is null) then
    raise exception 'Every line needs an account from this hotel''s chart of accounts';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where coalesce((l->>'debit')::numeric, 0) < 0 or coalesce((l->>'credit')::numeric, 0) < 0) then
    raise exception 'Debits and credits cannot be negative';
  end if;
  select coalesce(sum((l->>'debit')::numeric), 0), coalesce(sum((l->>'credit')::numeric), 0) into dr, cr from jsonb_array_elements(p_lines) l;
  if round(dr, 2) <> round(cr, 2) or dr = 0 then raise exception 'Entry does not balance (debits %, credits %)', dr, cr; end if;
  insert into journal_entries(tenant_id, hotel_id, entry_date, memo, source, source_id) values (t, p_hotel, p_date, p_memo, p_source, p_source_id) returning id into jid;
  insert into journal_lines(entry_id, tenant_id, hotel_id, account_id, debit, credit, memo)
  select jid, t, p_hotel, public._hotel_gl(p_hotel, (l->>'account_id')::uuid), coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0), l->>'memo'
  from jsonb_array_elements(p_lines) l;
  return jid;
end $$;
