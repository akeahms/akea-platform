-- Chart of accounts in QuickBooks form (parent:child accounts, QuickBooks type and detail type) with account controls:
-- rename; make inactive (only at zero balance, nothing pending); make active; delete only if never used.
-- Inactive accounts stay in reports for their dates, labelled "(Inactive)", and can't receive new entries.
-- The company default chart is the QuickBooks "Default - Chart of Accounts" file (supabase/seed/default_chart_of_accounts.csv).

-- 1) structure ---------------------------------------------------------------------------------------------------------
alter table public.gl_accounts
  add column if not exists parent_id uuid references public.gl_accounts(id) on delete restrict,
  add column if not exists full_name text,
  add column if not exists qbo_type text,
  add column if not exists detail_type text,
  add column if not exists system_key text,
  add column if not exists template_id uuid references public.gl_accounts(id) on delete set null;
create index if not exists gl_accounts_parent on public.gl_accounts(parent_id);
create index if not exists gl_accounts_template on public.gl_accounts(template_id);

create or replace function public._gl_full_name() returns trigger language plpgsql set search_path = public as $$
declare p text;
begin
  new.name := btrim(new.name);
  if new.name = '' then raise exception 'An account needs a name'; end if;
  if position(':' in new.name) > 0 then raise exception 'Account names can''t contain ":" (it separates parent and sub-accounts)'; end if;
  if new.parent_id is not null then
    if new.parent_id = new.id then raise exception 'An account can''t be its own parent'; end if;
    if exists (with recursive up as (select id, parent_id from gl_accounts where id = new.parent_id
                                     union all select g.id, g.parent_id from gl_accounts g join up on g.id = up.parent_id)
               select 1 from up where id = new.id) then raise exception 'That would put the account under itself'; end if;
    select full_name into p from gl_accounts where id = new.parent_id;
  end if;
  new.full_name := coalesce(p || ':', '') || new.name;
  return new;
end $$;
create trigger gl_accounts_full_name before insert or update of name, parent_id on public.gl_accounts for each row execute function public._gl_full_name();
create or replace function public._gl_rename_children() returns trigger language plpgsql set search_path = public as $$
begin
  update gl_accounts set parent_id = parent_id where parent_id = new.id;   -- recomputes each child's full name (and theirs)
  return null;
end $$;
create trigger gl_accounts_rename_children after update of full_name on public.gl_accounts for each row
  when (old.full_name is distinct from new.full_name) execute function public._gl_rename_children();
update public.gl_accounts set name = name;

create or replace function public._akea_type(q text) returns text language sql immutable as $$
  select case
    when q ilike 'income' or q ilike 'other income' then 'revenue'
    when q ilike 'expense' or q ilike 'other expense' or q ilike 'cost of goods sold' then 'expense'
    when q ilike 'equity' then 'equity'
    when q ilike '%payable%' or q ilike 'credit card' or q ilike '%liabilit%' then 'liability'
    else 'asset' end
$$;
-- number ranges by QuickBooks type; new accounts get the next free number in their range, in steps of 10
create or replace function public._gl_band(q text) returns int[] language sql immutable as $$
  select case
    when q ilike 'bank' then array[1000, 1050] when q ilike 'accounts receivable%' then array[1100, 1200]
    when q ilike 'other current asset' then array[1200, 1500] when q ilike 'fixed asset' then array[1500, 1900]
    when q ilike 'other asset' then array[1900, 2000] when q ilike 'accounts payable%' then array[2000, 2100]
    when q ilike 'credit card' then array[2100, 2200] when q ilike 'other current liability' then array[2200, 2700]
    when q ilike 'long term liability' then array[2700, 3000] when q ilike 'equity' then array[3000, 4000]
    when q ilike 'income' then array[4000, 4800] when q ilike 'other income' then array[4800, 4900]
    when q ilike 'cost of goods sold' then array[4900, 5000] when q ilike 'other expense' then array[8000, 9000]
    else array[5000, 8000] end
$$;
create or replace function public._next_gl_number(p_tenant uuid, p_hotel uuid, p_qbo text) returns text language plpgsql stable set search_path = public as $$
declare b int[] := public._gl_band(p_qbo); c int;
begin
  select coalesce(max(number::int) + 10, b[1]) into c from gl_accounts
   where tenant_id = p_tenant and hotel_id is not distinct from p_hotel and number ~ '^\d{1,6}$' and number::int >= b[1] and number::int < b[2];
  while exists (select 1 from gl_accounts where tenant_id = p_tenant and hotel_id is not distinct from p_hotel and number = c::text) loop c := c + 10; end loop;
  return c::text;
end $$;
create or replace function public._gl_defaults() returns trigger language plpgsql set search_path = public as $$
begin
  if new.qbo_type is not null and (tg_op = 'INSERT' or new.qbo_type is distinct from old.qbo_type) then new.type := public._akea_type(new.qbo_type); end if;
  if new.qbo_type is null and tg_op = 'INSERT' then
    new.qbo_type := case new.type when 'revenue' then 'Income' when 'expense' then 'Expense' when 'equity' then 'Equity' when 'liability' then 'Other Current Liability' else 'Other Current Asset' end;
  end if;
  if coalesce(btrim(new.number), '') = '' then new.number := public._next_gl_number(new.tenant_id, new.hotel_id, new.qbo_type); end if;
  if new.parent_id is not null and tg_op = 'INSERT' and not exists (select 1 from gl_accounts p where p.id = new.parent_id and p.tenant_id = new.tenant_id and p.hotel_id is not distinct from new.hotel_id) then
    raise exception 'A sub-account must sit under an account in the same chart';
  end if;
  return new;
end $$;
create trigger gl_accounts_defaults before insert or update of qbo_type, number on public.gl_accounts for each row execute function public._gl_defaults();

-- 2) importing a QuickBooks chart (Account, Type, Detail Type; parents before children) -----------------------------------
create or replace function public._import_chart(p_tenant uuid, p_hotel uuid, p_rows jsonb, p_convert jsonb default null) returns int language plpgsql security definer set search_path = public as $$
-- p_convert: optional {"Full:Path": "old account number"}; that existing account becomes the imported one (keeps its history)
declare r jsonb; path text; leaf text; ppath text; ex uuid; pid uuid; n int := 0;
begin
  for r in select value from jsonb_array_elements(p_rows) loop
    path := btrim(regexp_replace(r->>'account', '\s*:\s*', ':', 'g'));
    continue when coalesce(path, '') = '';
    leaf := regexp_replace(path, '^.*:', '');
    ppath := case when position(':' in path) > 0 then left(path, length(path) - length(leaf) - 1) end;
    select id into ex from gl_accounts where tenant_id = p_tenant and hotel_id is not distinct from p_hotel and lower(full_name) = lower(path);
    if ex is not null then
      update gl_accounts set qbo_type = coalesce(qbo_type, nullif(r->>'type', '')), detail_type = coalesce(detail_type, nullif(r->>'detail', '')) where id = ex;
      continue;
    end if;
    pid := null;
    if ppath is not null then
      select id into pid from gl_accounts where tenant_id = p_tenant and hotel_id is not distinct from p_hotel and lower(full_name) = lower(ppath);
      if pid is null then raise exception 'The parent account "%" must be listed before "%"', ppath, path; end if;
    end if;
    ex := null;
    if p_convert ? path then
      select id into ex from gl_accounts where tenant_id = p_tenant and hotel_id is not distinct from p_hotel and number = p_convert->>path and system_key is null and detail_type is null;
    end if;
    if ex is not null then
      update gl_accounts set name = leaf, parent_id = pid, qbo_type = coalesce(nullif(r->>'type', ''), 'Expense'), detail_type = nullif(r->>'detail', ''),
             section = coalesce(replace(ppath, ':', ' › '), coalesce(nullif(r->>'type', ''), 'Expense')) where id = ex;
      continue;
    end if;
    insert into gl_accounts(tenant_id, hotel_id, parent_id, name, qbo_type, detail_type, section, active)
    values (p_tenant, p_hotel, pid, leaf, coalesce(nullif(r->>'type', ''), 'Expense'), nullif(r->>'detail', ''),
            coalesce(replace(ppath, ':', ' › '), coalesce(nullif(r->>'type', ''), 'Expense')), true);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public._import_chart(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;

-- 3) the accounts the platform posts to automatically ---------------------------------------------------------------------
create unique index if not exists gl_accounts_scope_system on public.gl_accounts(tenant_id, coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid), system_key) where system_key is not null;
create or replace function public._gl_sys(p_hotel uuid, p_key text) returns uuid language sql stable security definer set search_path = public as $$
  select id from public.gl_accounts where hotel_id = p_hotel and system_key = p_key
$$;
revoke execute on function public._gl_sys(uuid, text) from public, anon, authenticated;

-- 4) convert every chart (company template, then each hotel) to the QuickBooks default -------------------------------------
insert into public.app_config(key, value) values ('default_chart', $rows$[{"account": "Accumulated Depreciation", "type": "Fixed Asset", "detail": "Accumulated Depreciation"}, {"account": "Buildings and Improvements", "type": "Fixed Asset", "detail": "Buildings"}, {"account": "Furniture and Equipment", "type": "Fixed Asset", "detail": "Furniture & Fixtures"}, {"account": "Land", "type": "Fixed Asset", "detail": "Land"}, {"account": "Opening Balance Equity", "type": "Equity", "detail": "Opening Balance Equity"}, {"account": "Retained Earnings", "type": "Equity", "detail": "Retained Earnings"}, {"account": "Income", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Banquet Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Bar Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Cancellation Fees", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Food Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Meeting Room Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Misc Income", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Pet Fees", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Recovery Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Room Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Room Revenue:AMEX", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Room Revenue:Cash Deposit", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Room Revenue:DISCOVER", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Room Revenue:VI/MC/DS", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Sales Tax Commission", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Sundry Shop Revenue", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Income:Vending Income", "type": "Income", "detail": "Sales of Product Income"}, {"account": "Depreciation Expense", "type": "Other Expense", "detail": "Depreciation"}, {"account": "Expenses", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Banquet Food", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Bar Supplies", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Beer", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Cleaning Supplies", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Equipment Rental", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Food Costs", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Kitchen Supplies", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Linen Rental", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Liquor", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Other Beverage", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Payroll Taxes- F&B", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages- Banquet", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages- Bar/Server", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages- Cook", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages- F&B Manager", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages- Holiday F&B", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages- Tips Clearing", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages - Overtime F&B", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wages - Vacation Rooms (F&B)", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Wine", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Meeting Room Expenses", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Meeting Room Expenses:Equipment", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Meeting Room Expenses:Food & Beverages", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Payroll Taxes Rooms", "type": "Expense", "detail": "Payroll Tax Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Cleaning Supplies", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Complimentary Guest Amenities", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Contract Cleaning", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Guest Room Supplies", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Kitchen Supplies", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Laundry Chemicals", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Linen Expense", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Room Equipment", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Travel Agent Commissions", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:TV Cable & Internet", "type": "Expense", "detail": "Utilities"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Uniforms", "type": "Expense", "detail": "Supplies & Materials"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Payroll Costs", "type": "Expense", "detail": "Payroll Wage Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Wages- Holiday Rooms", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Wages Front Desk", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Wages Houseman", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Wages Laundry", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Wages Operations Manager", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Wages Security", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:WagesHousekeeping", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:WagesOT Rooms", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Room Expenses:WagesVacation/Sick Rooms", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:DEPARTMENT EXPENSES:Telecommunciations", "type": "Expense", "detail": "Communication"}, {"account": "Expenses:DEPARTMENT EXPENSES:Telecommunciations:Cell Phones", "type": "Expense", "detail": "Communication"}, {"account": "Expenses:DEPARTMENT EXPENSES:Telecommunciations:MiscellaneousTelephone", "type": "Expense", "detail": "Communication"}, {"account": "Expenses:DEPARTMENT EXPENSES:Telecommunciations:Phone Equip. Maint. Contract", "type": "Expense", "detail": "Communication"}, {"account": "Expenses:DEPARTMENT EXPENSES:Telecommunciations:Telephone Local/LD", "type": "Expense", "detail": "Communication"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Assistance GM", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Health Insurance", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Insurance Other", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Payroll Processing Fee", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Payroll Taxes A&G", "type": "Expense", "detail": "Payroll Tax Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Wages- Task Force Manager", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Wages Bonus", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:Wages General Manager", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll:WagesVacation/Sick A&G", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Accounting Fee", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Automobile Expense", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Bad Debts  Chargebacks", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Bank Service Charges", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Bottled Water - In Room", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Business Taxes & Licenses", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Cash Over/Short", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Conference", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Credit Card Over/Short", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Credit Card Processing Fees", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Dues, Fees & Subscriptions", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Employee Appreciation", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Guest Assistance Fees- Hilton", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Help Wanted Ads", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Meals & Entertainment", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Miscellaneous Expense", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Office Supplies", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Postage", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Sundry Shop Supplies", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Training", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Travelair / Mileage / Lodging", "type": "Expense", "detail": "Office/General Administrative Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Appliances", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Building Repairs", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Carpentry", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Fire Protection", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Furniture/ Beds", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Guest Room Repairs", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:HVAC", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Light Bulbs", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Maintenance Tools/Supplies", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Miscellaneous Repairs", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Painting Supplies", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Plumbing & Electrical", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contract- Pest Control", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contract Elevator", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contract Landscape", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contract Laundry", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contract Trash", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contracts Computer", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Service Contracts Other", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Snow Removal", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Swimming Pool", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll:Payroll Taxes Maint", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll:Wages- Vacation Maint", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll:Wages Holiday Maint", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll:WagesMaintenance", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll:WagesOT Maint", "type": "Expense", "detail": "Repair & Maintenance"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Advertising / Public relations", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Advertising/National", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:AdvertisingReservation", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Brand Sales Services", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Brochures & Fliers", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Franchise Fees", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Guest Appreciation", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Loyalty Program Expense", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Promotional Supplies", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Referral Fees", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Revenue Management", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Sponsership and Donations", "type": "Expense", "detail": "Advertising/Promotional"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing Payroll", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing Payroll:Payroll Taxes Sales", "type": "Expense", "detail": "Payroll Tax Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing Payroll:Wages- Bonus Sales", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing Payroll:Wages Sales", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing Payroll:WagesOT Sales", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing Payroll:WagesVacation/Sick Sales", "type": "Expense", "detail": "Payroll Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:STATS", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:STATS:Rooms Available", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:STATS:Rooms Rented", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:STATS:Stat Clearing Account", "type": "Expense", "detail": "Other Business Expenses"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Utilities", "type": "Expense", "detail": "Utilities"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Utilities:Utilities Electricity", "type": "Expense", "detail": "Utilities"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Utilities:Utilities Gas", "type": "Expense", "detail": "Utilities"}, {"account": "Expenses:UNDISTRIBUTED EXPENSES:Utilities:Utilities Water/Sewer", "type": "Expense", "detail": "Utilities"}, {"account": "Ask My Accountant", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Capital Expenditures", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Extraordinary Expense", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Insurance Property & Casualty", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Insurance Works Comp", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Management Fee", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Owner Expense", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}, {"account": "Other Expenses:Taxes Real Property", "type": "Other Expense", "detail": "Other Miscellaneous Expense"}]$rows$)
  on conflict (key) do update set value = excluded.value, updated_at = now();

create or replace function public._gl_uses(p_id uuid) returns int language sql stable security definer set search_path = public as $$
  select ((select count(*) from bills where gl_account_id = p_id) + (select count(*) from po_lines where gl_account_id = p_id)
        + (select count(*) from journal_lines where account_id = p_id) + (select count(*) from budget_gl where account_id = p_id)
        + (select count(*) from bank_accounts where gl_account_id = p_id) + (select count(*) from bank_transactions where gl_account_id = p_id)
        + (select count(*) from qbo_account_map where gl_account_id = p_id) + (select count(*) from vendors where default_gl = p_id)
        + (select count(*) from gl_accounts where template_id = p_id))::int
$$;
revoke execute on function public._gl_uses(uuid) from public, anon, authenticated;

do $conv$
declare
  rows jsonb := (select value::jsonb from public.app_config where key = 'default_chart');
  mapping jsonb := '{"1500": "Furniture and Equipment", "3000": "Opening Balance Equity", "4000": "Income:Room Revenue", "4100": "Income:Food Revenue", "4200": "Income:Misc Income", "5000": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Payroll Costs", "5010": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Guest Room Supplies", "5020": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Linen Expense", "5030": "Expenses:DEPARTMENT EXPENSES:Room Expenses:Room Costs Other:Travel Agent Commissions", "5040": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:AdvertisingReservation", "5100": "Expenses:DEPARTMENT EXPENSES:Food & Beverage:Food Costs", "6000": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General:Admin & General Payroll", "6010": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Credit Card Processing Fees", "6020": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Accounting Fee", "6030": "Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Office Supplies", "6100": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other", "6110": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Brand Sales Services", "6200": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Payroll", "6210": "Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Miscellaneous Repairs", "6300": "Expenses:UNDISTRIBUTED EXPENSES:Utilities:Utilities Electricity", "6310": "Expenses:UNDISTRIBUTED EXPENSES:Utilities:Utilities Gas", "6320": "Expenses:UNDISTRIBUTED EXPENSES:Utilities:Utilities Water/Sewer", "6400": "Other Expenses:Management Fee", "7000": "Other Expenses:Taxes Real Property", "7010": "Other Expenses:Insurance Property & Casualty", "7200": "Depreciation Expense", "6500": "Expenses:UNDISTRIBUTED EXPENSES:Sales & Marketing:Sales & Marketing- Other:Franchise Fees", "7300": "Other Expenses:Capital Expenditures"}'::jsonb;
  sys jsonb := '{"1000":["cash","Bank","Checking"],"1010":["payroll_cash","Bank","Checking"],"1050":["card_clearing","Other Current Asset","Undeposited Funds"],
                 "1100":["guest_ledger","Other Current Asset","Other Current Assets"],"1110":["ar_direct_bill","Accounts receivable (A/R)","Accounts Receivable (A/R)"],
                 "2000":["ap","Accounts payable (A/P)","Accounts Payable (A/P)"],"2200":["sales_tax","Other Current Liability","Sales Tax Payable"]}'::jsonb;
  csv_sys jsonb := '{"room_revenue":"Income:Room Revenue","fnb_revenue":"Income:Food Revenue","other_revenue":"Income:Misc Income",
    "default_expense":"Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Miscellaneous Repairs",
    "card_fees":"Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Credit Card Processing Fees"}'::jsonb;
  sc record; k text; a record;
begin
  perform set_config('akea.approved_path', 'on', true);
  for sc in select distinct tenant_id, hotel_id from gl_accounts order by tenant_id, hotel_id nulls first loop
    -- system accounts keep their numbers and get QuickBooks types
    for k in select jsonb_object_keys(sys) loop
      update gl_accounts set system_key = sys->k->>0, qbo_type = sys->k->>1, detail_type = sys->k->>2
       where tenant_id = sc.tenant_id and hotel_id is not distinct from sc.hotel_id and number = k;
    end loop;
    -- import; existing accounts named in the mapping become their QuickBooks equivalent (same row, history stays attached)
    perform public._import_chart(sc.tenant_id, sc.hotel_id, rows, (select jsonb_object_agg(value, key) from jsonb_each_text(mapping)));
    -- leftovers from the old chart: unused ones are made inactive (delete them from the chart page if you like);
    -- used ones stay active because an account with a balance can't be made inactive
    for a in select id, type from gl_accounts where tenant_id = sc.tenant_id and hotel_id is not distinct from sc.hotel_id and detail_type is null and system_key is null loop
      update gl_accounts set detail_type = 'Kept from the earlier chart', active = (public._gl_uses(a.id) > 0),
             qbo_type = case a.type when 'revenue' then 'Income' when 'expense' then 'Expense' when 'equity' then 'Equity' when 'liability' then 'Other Current Liability' else 'Other Current Asset' end
       where id = a.id;
    end loop;
    for k in select jsonb_object_keys(csv_sys) loop
      update gl_accounts set system_key = k where tenant_id = sc.tenant_id and hotel_id is not distinct from sc.hotel_id and lower(full_name) = lower(csv_sys->>k);
    end loop;
    -- renumber in QuickBooks order within each type range (system bank / receivable / payable / tax accounts keep theirs)
    update gl_accounts set number = 'tmp-' || id where tenant_id = sc.tenant_id and hotel_id is not distinct from sc.hotel_id and number !~ '^(1000|1010|1050|1100|1110|2000|2200)$';
    for a in
      select g.id, g.qbo_type from gl_accounts g
      left join lateral (select x.ord from jsonb_array_elements(rows) with ordinality x(r, ord) where lower(x.r->>'account') = lower(g.full_name) limit 1) o on true
      where g.tenant_id = sc.tenant_id and g.hotel_id is not distinct from sc.hotel_id and g.number like 'tmp-%'
      order by (public._gl_band(g.qbo_type))[1], o.ord nulls last, g.full_name
    loop
      update gl_accounts set number = public._next_gl_number(sc.tenant_id, sc.hotel_id, a.qbo_type) where id = a.id;
    end loop;
  end loop;
  -- hotel accounts remember which template account they came from
  update gl_accounts h set template_id = t.id from gl_accounts t
   where h.hotel_id is not null and t.hotel_id is null and t.tenant_id = h.tenant_id and lower(t.full_name) = lower(h.full_name);
end $conv$;

create unique index if not exists gl_accounts_scope_fullname on public.gl_accounts(tenant_id, coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(full_name));

-- 5) finance functions post by role, not by number ------------------------------------------------------------------------
do $$
declare f record; def text; newdef text;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('decide_bill', 'pay_bills', 'auto_reconcile', 'match_transaction') loop
    def := pg_get_functiondef(f.oid); newdef := def;
    newdef := regexp_replace(newdef, 'public\._gl_h\((\w+)\.hotel_id, ''2000''\)', 'public._gl_sys(\1.hotel_id, ''ap'')', 'g');
    newdef := regexp_replace(newdef, 'public\._gl_h\((\w+)\.hotel_id, ''6210''\)', 'public._gl_sys(\1.hotel_id, ''default_expense'')', 'g');
    newdef := regexp_replace(newdef, 'public\._gl_h\((\w+)\.hotel_id, ''6010''\)', 'public._gl_sys(\1.hotel_id, ''card_fees'')', 'g');
    newdef := regexp_replace(newdef, 'public\._gl_h\((\w+)\.hotel_id, ''1000''\)', 'public._gl_sys(\1.hotel_id, ''cash'')', 'g');
    if newdef <> def then execute newdef; end if;
  end loop;
end $$;

-- template → hotel translation follows the template link, then the system role, then the name
create or replace function public._hotel_gl(p_hotel uuid, p_gl uuid) returns uuid language sql stable security definer set search_path = public as $$
  select case when g.hotel_id = p_hotel then g.id
              when g.hotel_id is null then coalesce(
                (select x.id from gl_accounts x where x.hotel_id = p_hotel and x.template_id = g.id limit 1),
                (select x.id from gl_accounts x where x.hotel_id = p_hotel and g.system_key is not null and x.system_key = g.system_key),
                (select x.id from gl_accounts x where x.hotel_id = p_hotel and lower(x.full_name) = lower(g.full_name)))
         end
  from gl_accounts g where g.id = p_gl
$$;

-- a new hotel copies the template with its structure
create or replace function public._copy_templates(p_hotel uuid) returns int language plpgsql security definer set search_path = public as $$
declare t uuid; n int := 0; m int; r record;
begin
  select tenant_id into t from hotels where id = p_hotel;
  for r in with recursive tree as (
             select g.id, g.parent_id, g.number, g.name, g.type, g.section, g.active, g.qbo_type, g.detail_type, g.system_key, g.full_name, 0 as depth
             from gl_accounts g where g.tenant_id = t and g.hotel_id is null and g.parent_id is null
             union all
             select g.id, g.parent_id, g.number, g.name, g.type, g.section, g.active, g.qbo_type, g.detail_type, g.system_key, g.full_name, tree.depth + 1
             from gl_accounts g join tree on g.parent_id = tree.id)
           select * from tree order by depth, number loop
    continue when exists (select 1 from gl_accounts x where x.hotel_id = p_hotel and (x.template_id = r.id or lower(x.full_name) = lower(r.full_name)));
    insert into gl_accounts(tenant_id, hotel_id, number, name, type, section, active, qbo_type, detail_type, system_key, template_id, parent_id)
    values (t, p_hotel, case when exists (select 1 from gl_accounts x where x.hotel_id = p_hotel and x.number = r.number) then null else r.number end,
            r.name, r.type, r.section, r.active, r.qbo_type, r.detail_type,
            case when exists (select 1 from gl_accounts x where x.hotel_id = p_hotel and x.system_key = r.system_key) then null else r.system_key end, r.id,
            (select x.id from gl_accounts x where x.hotel_id = p_hotel and x.template_id = r.parent_id limit 1));
    n := n + 1;
  end loop;
  insert into departments(tenant_id, hotel_id, name, color, sort)
  select t, p_hotel, d.name, d.color, d.sort from departments d
  where d.tenant_id = t and d.hotel_id is null and not exists (select 1 from departments x where x.hotel_id = p_hotel and x.name = d.name);
  get diagnostics m = row_count;
  return n + m;
end $$;

-- new companies start from the stored default chart plus the system accounts
create or replace function public.create_default_gl(t uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into gl_accounts(tenant_id, number, name, type, section, qbo_type, detail_type, system_key)
  select t, v.number, v.name, public._akea_type(v.q), v.q, v.q, v.d, v.k from (values
    ('1000', 'Operating Cash', 'Bank', 'Checking', 'cash'), ('1010', 'Payroll Cash', 'Bank', 'Checking', 'payroll_cash'),
    ('1050', 'Credit Card Clearing', 'Other Current Asset', 'Undeposited Funds', 'card_clearing'), ('1100', 'Guest Ledger', 'Other Current Asset', 'Other Current Assets', 'guest_ledger'),
    ('1110', 'Accounts Receivable — Direct Bill', 'Accounts receivable (A/R)', 'Accounts Receivable (A/R)', 'ar_direct_bill'),
    ('2000', 'Accounts Payable', 'Accounts payable (A/P)', 'Accounts Payable (A/P)', 'ap'), ('2200', 'Sales & Occupancy Tax Payable', 'Other Current Liability', 'Sales Tax Payable', 'sales_tax')
  ) as v(number, name, q, d, k)
  where not exists (select 1 from gl_accounts g where g.tenant_id = t and g.hotel_id is null and g.system_key = v.k);
  perform public._import_chart(t, null, (select value::jsonb from app_config where key = 'default_chart'), null);
  update gl_accounts g set system_key = s.k from (values ('room_revenue', 'Income:Room Revenue'), ('fnb_revenue', 'Income:Food Revenue'), ('other_revenue', 'Income:Misc Income'),
    ('default_expense', 'Expenses:UNDISTRIBUTED EXPENSES:Repairs & Maintenance:Repairs & Maintenance Other:Miscellaneous Repairs'),
    ('card_fees', 'Expenses:UNDISTRIBUTED EXPENSES:Admin & General-Other Expenses:Credit Card Processing Fees')) as s(k, fullname)
  where g.tenant_id = t and g.hotel_id is null and lower(g.full_name) = lower(s.fullname) and g.system_key is null;
end $$;

-- 6) inactive accounts can't receive new entries (existing history is untouched) ---------------------------------------------
create or replace function public._same_hotel() returns trigger language plpgsql security definer set search_path = public as $$
declare i int; col text; tbl text; val uuid; owner uuid; fixed uuid; j jsonb := to_jsonb(new); o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
        acct record;
begin
  for i in 0 .. tg_nargs - 1 loop
    col := split_part(tg_argv[i], ':', 1); tbl := split_part(tg_argv[i], ':', 2);
    val := nullif(j ->> col, '')::uuid;
    continue when val is null;
    if tbl = 'gl_accounts' then
      fixed := public._hotel_gl(new.hotel_id, val);
      if fixed is null then raise exception 'That account belongs to another hotel''s books (or this hotel has no matching account). Use one of this hotel''s accounts.'; end if;
      if (o is null or (o ->> col) is distinct from fixed::text) then
        select full_name, active into acct from gl_accounts where id = fixed;
        if not acct.active then raise exception 'The account "%" is inactive. Choose an active account (or make it active again in the chart of accounts).', acct.full_name; end if;
      end if;
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

-- 7) account controls ----------------------------------------------------------------------------------------------------------
create or replace function public._gl_admin(p_id uuid) returns gl_accounts language plpgsql stable security definer set search_path = public as $$
declare g gl_accounts;
begin
  select * into g from gl_accounts where id = p_id;
  if g.id is null or g.tenant_id not in (select my_tenant_ids()) or perm_level(g.tenant_id, 'finance') < 4
     or (g.hotel_id is not null and not can_access_hotel(g.hotel_id)) then raise exception 'Changing the chart of accounts needs finance admin rights for this hotel'; end if;
  return g;
end $$;
revoke execute on function public._gl_admin(uuid) from public, anon, authenticated;

-- balance: all-time for balance-sheet accounts; this year for income and expense accounts (they close each year)
create or replace function public._gl_balance(p_id uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.debit - l.credit), 0) from journal_lines l join journal_entries e on e.id = l.entry_id join gl_accounts g on g.id = l.account_id
  where l.account_id = p_id and (g.type in ('asset', 'liability', 'equity') or e.entry_date >= date_trunc('year', current_date)::date)
$$;
revoke execute on function public._gl_balance(uuid) from public, anon, authenticated;

create or replace function public.gl_account_status(p_ids uuid[]) returns table (id uuid, uses int, children int, balance numeric, pending int)
language sql stable security definer set search_path = public as $$
  select g.id, public._gl_uses(g.id), (select count(*)::int from gl_accounts c where c.parent_id = g.id),
         round(public._gl_balance(g.id), 2),
         ((select count(*) from bills b where b.gl_account_id = g.id and b.status in ('draft', 'pending_approval'))
          + (select count(*) from po_lines pl join purchase_orders po on po.id = pl.po_id where pl.gl_account_id = g.id and po.status in ('draft', 'submitted', 'approved', 'ordered')))::int
  from gl_accounts g
  where g.id = any(p_ids) and g.tenant_id in (select my_tenant_ids()) and perm_level(g.tenant_id, 'finance') >= 1 and (g.hotel_id is null or can_access_hotel(g.hotel_id))
$$;
revoke execute on function public.gl_account_status(uuid[]) from public, anon;
grant execute on function public.gl_account_status(uuid[]) to authenticated;

create or replace function public.rename_account(p_id uuid, p_name text, p_number text default null, p_detail text default null) returns text
language plpgsql security definer set search_path = public as $$
declare g gl_accounts := public._gl_admin(p_id);
begin
  if p_number is not null and btrim(p_number) <> '' and exists (select 1 from gl_accounts x where x.tenant_id = g.tenant_id and x.hotel_id is not distinct from g.hotel_id and x.number = btrim(p_number) and x.id <> g.id) then
    raise exception 'Account number % is already used in this chart', btrim(p_number);
  end if;
  update gl_accounts set name = p_name, number = coalesce(nullif(btrim(p_number), ''), number), detail_type = coalesce(nullif(btrim(p_detail), ''), detail_type) where id = g.id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (g.tenant_id, auth.uid(), 'rename', 'gl_account', g.id::text, jsonb_build_object('from', g.full_name, 'to', p_name));
  return (select full_name from gl_accounts where id = g.id);
end $$;

create or replace function public.set_account_active(p_id uuid, p_active boolean) returns int language plpgsql security definer set search_path = public as $$
declare g gl_accounts := public._gl_admin(p_id); r record; n int;
begin
  if p_active then
    -- an account comes back with its parents (a sub-account can't be active under an inactive parent)
    with recursive up as (select x.id, x.parent_id from gl_accounts x where x.id = g.id union all select x.id, x.parent_id from gl_accounts x join up on x.id = up.parent_id)
    update gl_accounts set active = true where id in (select up.id from up) and not active;
    get diagnostics n = row_count;
  else
    -- the account and its sub-accounts all need a zero balance and nothing pending
    for r in with recursive down as (select x.id from gl_accounts x where x.id = g.id union all select x.id from gl_accounts x join down on x.parent_id = down.id)
             select x.id, x.full_name, x.system_key, x.type, s.balance, s.pending from gl_accounts x
             join down on down.id = x.id cross join lateral public.gl_account_status(array[x.id]) s where x.active loop
      if r.system_key is not null then raise exception '"%" is used automatically by the platform (bank, receivable, payable, tax or default posting) and can''t be made inactive. You can rename it.', r.full_name; end if;
      if r.balance <> 0 then raise exception '"%" has a balance of % (%). Move the balance to another account with a journal entry, then make it inactive.', r.full_name, to_char(r.balance, 'FM999,999,990.00'), case when r.type in ('asset', 'liability', 'equity') then 'all time' else 'this year' end; end if;
      if r.pending > 0 then raise exception '"%" is on % bill(s) or purchase order(s) that aren''t posted yet. Finish or change those first.', r.full_name, r.pending; end if;
    end loop;
    with recursive down as (select x.id from gl_accounts x where x.id = g.id union all select x.id from gl_accounts x join down on x.parent_id = down.id)
    update gl_accounts set active = false where id in (select down.id from down) and active;
    get diagnostics n = row_count;
  end if;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (g.tenant_id, auth.uid(), case when p_active then 'activate' else 'deactivate' end, 'gl_account', g.id::text, jsonb_build_object('account', g.full_name, 'accounts', n));
  return n;
end $$;

-- import a QuickBooks chart export (Account, Type, Detail Type) into a hotel's chart or the company template
create or replace function public.import_chart(p_hotel uuid, p_rows jsonb, p_tenant uuid default null) returns int language plpgsql security definer set search_path = public as $$
declare t uuid := coalesce((select tenant_id from hotels where id = p_hotel), p_tenant);
begin
  if t is null or t not in (select my_tenant_ids()) or perm_level(t, 'finance') < 4 or (p_hotel is not null and not can_access_hotel(p_hotel)) then
    raise exception 'Importing a chart of accounts needs finance admin rights';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'Send up to 2,000 accounts'; end if;
  return public._import_chart(t, p_hotel, p_rows);
end $$;
revoke execute on function public.rename_account(uuid, text, text, text), public.set_account_active(uuid, boolean), public.import_chart(uuid, jsonb, uuid) from public, anon;
grant execute on function public.rename_account(uuid, text, text, text), public.set_account_active(uuid, boolean), public.import_chart(uuid, jsonb, uuid) to authenticated;

-- 8) reports keep inactive accounts for their dates, labelled "(Inactive)" ---------------------------------------------------
do $$
declare def text;
begin
  def := pg_get_functiondef('public.pnl(date, date, uuid[])'::regprocedure);
  def := replace(def, 'select a.section sec, a.name acct, a.number num,', 'select a.section sec, a.name || case when a.active then '''' else '' (Inactive)'' end acct, a.number num,');
  execute def;
end $$;
