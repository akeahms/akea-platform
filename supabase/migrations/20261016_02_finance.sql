-- Phase 3: Finance — chart of accounts, vendors, bills & bill pay, purchasing, journal, budgets, banking & reconciliation.

create table public.gl_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number text not null, name text not null,
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  section text,                    -- USALI grouping, e.g. 'Rooms', 'Undistributed — A&G'
  active boolean not null default true,
  unique (tenant_id, number)
);

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, dba text, category text,
  contact_name text, email text, phone text, address text,
  payment_terms text default 'Net 30', default_gl uuid references public.gl_accounts(id) on delete set null,
  remit_method text default 'ach' check (remit_method in ('ach','check','card','wire','autopay')),
  w9_on_file boolean not null default false, tax_id_last4 text check (tax_id_last4 is null or tax_id_last4 ~ '^\d{4}$'),
  is_1099 boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive')),
  notes text, data_source text not null default 'live', created_at timestamptz not null default now()
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  po_no text not null, department_id uuid references public.departments(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','ordered','received','closed')),
  needed_by date, notes text, total numeric(14,2) not null default 0,
  requested_by uuid default auth.uid(), approved_by uuid, approved_at timestamptz, decision_note text,
  data_source text not null default 'live', created_at timestamptz not null default now()
);
create table public.po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  item text not null, qty numeric(12,2) not null default 1, unit_cost numeric(12,2) not null default 0,
  gl_account_id uuid references public.gl_accounts(id) on delete set null, received_qty numeric(12,2) not null default 0
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  po_id uuid references public.purchase_orders(id) on delete set null,
  invoice_no text, invoice_date date, due_date date,
  amount numeric(14,2) not null default 0, gl_account_id uuid references public.gl_accounts(id) on delete set null,
  description text,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','scheduled','paid','rejected','void')),
  file_path text, extracted jsonb, source text not null default 'manual',
  submitted_by uuid default auth.uid(), approved_by uuid, approved_at timestamptz, decision_note text,
  scheduled_for date, paid_at date, payment_method text, payment_ref text, bank_account_id uuid,
  data_source text not null default 'live', created_at timestamptz not null default now()
);
create index bills_hotel_status on public.bills(hotel_id, status, due_date);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  entry_date date not null, memo text,
  source text not null default 'manual', source_id uuid,
  created_by uuid default auth.uid(), data_source text not null default 'live', created_at timestamptz not null default now()
);
create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  account_id uuid not null references public.gl_accounts(id),
  debit numeric(14,2) not null default 0, credit numeric(14,2) not null default 0, memo text,
  check (debit >= 0 and credit >= 0)
);
create index jl_hotel_acct on public.journal_lines(hotel_id, account_id);
create index je_hotel_date on public.journal_entries(hotel_id, entry_date);

create table public.budget_gl (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  account_id uuid not null references public.gl_accounts(id) on delete cascade,
  month date not null, amount numeric(14,2) not null default 0,
  version text not null default 'Budget',
  primary key (hotel_id, account_id, month, version)
);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  name text not null, institution text, last4 text check (last4 is null or last4 ~ '^\d{4}$'),
  kind text not null default 'operating' check (kind in ('operating','payroll','reserve','tax','other')),
  feed text not null default 'manual' check (feed in ('manual','plaid','finicity')),
  gl_account_id uuid references public.gl_accounts(id) on delete set null,
  balance numeric(14,2), balance_as_of date, last_synced_at timestamptz,
  data_source text not null default 'live', created_at timestamptz not null default now()
);

create table public.statement_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  file_name text, format text, rows_read int, rows_added int, duplicates int,
  period_from date, period_to date, opening_balance numeric(14,2), closing_balance numeric(14,2),
  ms_to_read int, imported_by uuid default auth.uid(), created_at timestamptz not null default now()
);

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  posted_date date not null, amount numeric(14,2) not null, description text, ref text, kind text,
  source text not null default 'manual', import_id uuid references public.statement_imports(id) on delete set null,
  external_id text, fingerprint text not null,
  status text not null default 'unmatched' check (status in ('unmatched','matched','excluded')),
  matched_kind text, matched_ids uuid[], variance numeric(14,2), gl_account_id uuid references public.gl_accounts(id) on delete set null,
  data_source text not null default 'live', created_at timestamptz not null default now(),
  unique (bank_account_id, fingerprint)
);
create index bt_acct_date on public.bank_transactions(bank_account_id, posted_date);

-- What the hotel expects to land in the bank: card batches, cash, OTA and direct-bill payments.
create table public.expected_deposits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  business_date date not null, source text not null,  -- visa, mastercard, amex, discover, cash, ota, direct_bill
  amount numeric(14,2) not null, expected_date date not null,
  status text not null default 'open' check (status in ('open','matched','written_off')),
  bank_transaction_id uuid references public.bank_transactions(id) on delete set null,
  report_id uuid, data_source text not null default 'live', created_at timestamptz not null default now()
);
create index ed_hotel_date on public.expected_deposits(hotel_id, expected_date, status);

-- ---------- security ----------
select public._std_rls('gl_accounts', 'finance', 'tenant', 4);
-- the chart of accounts is also readable to purchasing users (to code orders)
create policy gl_accounts_read_purch on public.gl_accounts for select to authenticated
  using (tenant_id in (select public.my_tenant_ids()) and public.perm_level(tenant_id, 'purchasing') >= 1);
select public._std_rls('vendors', 'finance', 'tenant');
create policy vendors_read_purch on public.vendors for select to authenticated
  using (tenant_id in (select public.my_tenant_ids()) and public.perm_level(tenant_id, 'purchasing') >= 1);
select public._std_rls('purchase_orders', 'purchasing', 'hotel');
select public._std_rls('po_lines', 'purchasing', 'hotel');
select public._std_rls('bills', 'finance', 'hotel');
select public._std_rls('journal_entries', 'finance', 'hotel');
select public._std_rls('journal_lines', 'finance', 'hotel');
select public._std_rls('budget_gl', 'finance', 'hotel');
select public._std_rls('bank_accounts', 'finance', 'hotel', 3);
select public._std_rls('statement_imports', 'finance', 'hotel');
select public._std_rls('bank_transactions', 'finance', 'hotel');
select public._std_rls('expected_deposits', 'finance', 'hotel');

-- Status changes that move money go through the approval functions below, not direct edits.
create or replace function public._guard_money_status() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('akea.approved_path', true), '') <> 'on'
     and new.status is distinct from old.status
     and new.status in ('approved','scheduled','paid','ordered','received','closed','rejected') then
    raise exception 'Use the Approve / Pay actions to change status to %', new.status;
  end if;
  return new;
end $$;
create trigger bills_guard before update on public.bills for each row execute function public._guard_money_status();
create trigger po_guard before update on public.purchase_orders for each row execute function public._guard_money_status();

-- ---------- chart of accounts (USALI-style, small-select-service friendly) ----------
create or replace function public.create_default_gl(t uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.gl_accounts(tenant_id, number, name, type, section) values
  (t,'1000','Operating Cash','asset','Assets'),(t,'1010','Payroll Cash','asset','Assets'),(t,'1050','Credit Card Clearing','asset','Assets'),
  (t,'1100','Guest Ledger','asset','Assets'),(t,'1110','Accounts Receivable — Direct Bill','asset','Assets'),(t,'1200','Inventory','asset','Assets'),
  (t,'1300','Prepaid Expenses','asset','Assets'),(t,'1500','Property & Equipment','asset','Assets'),(t,'1600','FF&E Reserve','asset','Assets'),
  (t,'2000','Accounts Payable','liability','Liabilities'),(t,'2100','Accrued Payroll','liability','Liabilities'),(t,'2200','Sales & Occupancy Tax Payable','liability','Liabilities'),
  (t,'2300','Advance Deposits','liability','Liabilities'),(t,'2500','Mortgage Payable','liability','Liabilities'),
  (t,'3000','Owner Equity','equity','Equity'),(t,'3100','Distributions','equity','Equity'),
  (t,'4000','Room Revenue','revenue','Rooms'),(t,'4100','Food & Beverage Revenue','revenue','F&B'),(t,'4200','Other Operated Revenue','revenue','Other'),(t,'4300','Miscellaneous Income','revenue','Other'),
  (t,'5000','Rooms Payroll','expense','Rooms'),(t,'5010','Rooms Supplies & Amenities','expense','Rooms'),(t,'5020','Laundry & Linen','expense','Rooms'),
  (t,'5030','Travel Agent & OTA Commissions','expense','Rooms'),(t,'5040','Reservation & Brand Fees','expense','Rooms'),
  (t,'5100','F&B Cost of Sales','expense','F&B'),(t,'5110','F&B Payroll','expense','F&B'),
  (t,'6000','A&G Payroll','expense','Undistributed — A&G'),(t,'6010','Credit Card Commissions','expense','Undistributed — A&G'),(t,'6020','Professional Fees','expense','Undistributed — A&G'),
  (t,'6030','Office & Technology','expense','Undistributed — A&G'),(t,'6100','Sales & Marketing','expense','Undistributed — S&M'),(t,'6110','Franchise Marketing Fees','expense','Undistributed — S&M'),
  (t,'6200','Maintenance Payroll','expense','Undistributed — Maintenance'),(t,'6210','Repairs & Maintenance','expense','Undistributed — Maintenance'),
  (t,'6300','Electricity','expense','Undistributed — Utilities'),(t,'6310','Gas','expense','Undistributed — Utilities'),(t,'6320','Water & Sewer','expense','Undistributed — Utilities'),
  (t,'6400','Management Fees','expense','Management Fees'),(t,'6500','Franchise Royalty','expense','Fixed — Franchise'),
  (t,'7000','Property Taxes','expense','Fixed Charges'),(t,'7010','Insurance','expense','Fixed Charges'),(t,'7100','Interest Expense','expense','Fixed Charges'),
  (t,'7200','Depreciation','expense','Fixed Charges'),(t,'7300','FF&E Reserve Contribution','expense','Fixed Charges')
  on conflict (tenant_id, number) do nothing;
$$;
revoke execute on function public.create_default_gl(uuid) from public, anon, authenticated;
select public.create_default_gl(id) from public.tenants;

create or replace function public._gl(t uuid, num text) returns uuid language sql stable security definer set search_path = public as $$
  select id from public.gl_accounts where tenant_id = t and number = num
$$;
revoke execute on function public._gl(uuid, text) from public, anon, authenticated;

-- ---------- journal ----------
create or replace function public.post_journal(p_hotel uuid, p_date date, p_memo text, p_lines jsonb, p_source text default 'manual', p_source_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; jid uuid; dr numeric; cr numeric;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null or not public.can_access_hotel(p_hotel) or public.perm_level(t, 'finance') < 2 then raise exception 'Not allowed'; end if;
  select coalesce(sum((l->>'debit')::numeric), 0), coalesce(sum((l->>'credit')::numeric), 0) into dr, cr from jsonb_array_elements(p_lines) l;
  if round(dr, 2) <> round(cr, 2) or dr = 0 then raise exception 'Entry does not balance (debits %, credits %)', dr, cr; end if;
  insert into journal_entries(tenant_id, hotel_id, entry_date, memo, source, source_id) values (t, p_hotel, p_date, p_memo, p_source, p_source_id) returning id into jid;
  insert into journal_lines(entry_id, tenant_id, hotel_id, account_id, debit, credit, memo)
  select jid, t, p_hotel, (l->>'account_id')::uuid, coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0), l->>'memo'
  from jsonb_array_elements(p_lines) l
  where exists (select 1 from gl_accounts a where a.id = (l->>'account_id')::uuid and a.tenant_id = t);
  return jid;
end $$;

-- ---------- approvals (respect each role's approval limit) ----------
create or replace function public._approval_limit(t uuid) returns numeric language sql stable security definer set search_path = public as $$
  -- null = unlimited; highest limit across the caller's memberships in this company
  select case when bool_or(r.approval_limit is null) then null else max(r.approval_limit) end
  from memberships m join roles r on r.id = m.role_id
  where m.user_id = auth.uid() and m.tenant_id = t and (m.expires_at is null or m.expires_at > now()) and public.mfa_ok(r.requires_mfa)
$$;
revoke execute on function public._approval_limit(uuid) from public, anon;

create or replace function public.decide_bill(p_id uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare b bills; lim numeric; ap uuid;
begin
  select * into b from bills where id = p_id for update;
  if b.id is null or not public.can_access_hotel(b.hotel_id) or public.perm_level(b.tenant_id, 'finance') < 3 then raise exception 'You do not have approval rights for bills'; end if;
  if b.status not in ('draft','pending_approval') then raise exception 'This bill is already %', b.status; end if;
  lim := public._approval_limit(b.tenant_id);
  if p_approve and lim is not null and b.amount > lim then
    raise exception 'This bill ($%) is above your approval limit ($%). It needs a higher approver.', b.amount, lim;
  end if;
  perform set_config('akea.approved_path', 'on', true);
  update bills set status = case when p_approve then 'approved' else 'rejected' end, approved_by = auth.uid(), approved_at = now(), decision_note = p_note where id = p_id;
  if p_approve then
    ap := public._gl(b.tenant_id, '2000');
    perform public.post_journal(b.hotel_id, coalesce(b.invoice_date, current_date), 'Bill ' || coalesce(b.invoice_no, '') || ' approved',
      jsonb_build_array(jsonb_build_object('account_id', coalesce(b.gl_account_id, public._gl(b.tenant_id, '6210')), 'debit', b.amount),
                        jsonb_build_object('account_id', ap, 'credit', b.amount)), 'bill', b.id);
  end if;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (b.tenant_id, auth.uid(), case when p_approve then 'approve' else 'reject' end, 'bill', b.id::text, jsonb_build_object('amount', b.amount, 'note', p_note));
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

create or replace function public.pay_bills(p_ids uuid[], p_bank uuid, p_method text, p_date date, p_ref text default null) returns int
language plpgsql security definer set search_path = public as $$
declare b bills; n int := 0; ba bank_accounts;
begin
  select * into ba from bank_accounts where id = p_bank;
  if ba.id is null then raise exception 'Choose a bank account'; end if;
  for b in select * from bills where id = any(p_ids) for update loop
    if not public.can_access_hotel(b.hotel_id) or public.perm_level(b.tenant_id, 'finance') < 3 then raise exception 'Not allowed'; end if;
    if b.status not in ('approved','scheduled') then raise exception 'Bill % is not approved yet', coalesce(b.invoice_no, b.id::text); end if;
    if ba.hotel_id <> b.hotel_id then raise exception 'Pay each hotel''s bills from that hotel''s bank account'; end if;
    perform set_config('akea.approved_path', 'on', true);
    if p_date > current_date then
      update bills set status = 'scheduled', scheduled_for = p_date, payment_method = p_method, payment_ref = p_ref, bank_account_id = p_bank where id = b.id;
    else
      update bills set status = 'paid', paid_at = p_date, payment_method = p_method, payment_ref = p_ref, bank_account_id = p_bank where id = b.id;
      perform public.post_journal(b.hotel_id, p_date, 'Payment ' || coalesce(b.invoice_no, ''),
        jsonb_build_array(jsonb_build_object('account_id', public._gl(b.tenant_id, '2000'), 'debit', b.amount),
                          jsonb_build_object('account_id', coalesce(ba.gl_account_id, public._gl(b.tenant_id, '1000')), 'credit', b.amount)), 'payment', b.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.decide_po(p_id uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare po purchase_orders; lim numeric;
begin
  select * into po from purchase_orders where id = p_id for update;
  if po.id is null or not public.can_access_hotel(po.hotel_id) or public.perm_level(po.tenant_id, 'purchasing') < 3 then raise exception 'You do not have approval rights for purchase orders'; end if;
  if po.status not in ('draft','submitted') then raise exception 'This order is already %', po.status; end if;
  lim := public._approval_limit(po.tenant_id);
  if p_approve and lim is not null and po.total > lim then raise exception 'This order ($%) is above your approval limit ($%)', po.total, lim; end if;
  perform set_config('akea.approved_path', 'on', true);
  update purchase_orders set status = case when p_approve then 'approved' else 'rejected' end, approved_by = auth.uid(), approved_at = now(), decision_note = p_note where id = p_id;
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

create or replace function public.advance_po(p_id uuid, p_to text) returns text
language plpgsql security definer set search_path = public as $$
declare po purchase_orders; bid uuid;
begin
  select * into po from purchase_orders where id = p_id for update;
  if po.id is null or not public.can_access_hotel(po.hotel_id) or public.perm_level(po.tenant_id, 'purchasing') < 2 then raise exception 'Not allowed'; end if;
  if not ((po.status = 'approved' and p_to = 'ordered') or (po.status in ('approved','ordered') and p_to = 'received') or (po.status = 'received' and p_to = 'closed')) then
    raise exception 'Cannot move an order from % to %', po.status, p_to;
  end if;
  perform set_config('akea.approved_path', 'on', true);
  update purchase_orders set status = p_to where id = p_id;
  if p_to = 'received' then
    update po_lines set received_qty = qty where po_id = p_id;
    -- receiving creates a draft bill for accounts payable to match against the invoice
    insert into bills(tenant_id, hotel_id, vendor_id, po_id, description, amount, gl_account_id, status, source, invoice_date, due_date)
    select po.tenant_id, po.hotel_id, po.vendor_id, po.id, 'From PO ' || po.po_no, po.total,
           (select gl_account_id from po_lines where po_id = p_id and gl_account_id is not null limit 1), 'draft', 'po', current_date, current_date + 30
    returning id into bid;
  end if;
  return p_to;
end $$;

-- ---------- bank import (one call for the whole statement, duplicates skipped) ----------
create or replace function public.import_bank_transactions(p_account uuid, p_rows jsonb, p_meta jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = public as $$
declare ba bank_accounts; imp uuid; added int; total int; rec jsonb;
begin
  select * into ba from bank_accounts where id = p_account;
  if ba.id is null then raise exception 'Bank account not found'; end if;
  total := jsonb_array_length(p_rows);
  insert into statement_imports(tenant_id, hotel_id, bank_account_id, file_name, format, rows_read, period_from, period_to, opening_balance, closing_balance, ms_to_read)
  values (ba.tenant_id, ba.hotel_id, ba.id, p_meta->>'file_name', p_meta->>'format', total, (p_meta->>'from')::date, (p_meta->>'to')::date,
          (p_meta->>'opening')::numeric, (p_meta->>'closing')::numeric, (p_meta->>'ms')::int)
  returning id into imp;
  with src as (
    select (r->>'date')::date d, round((r->>'amount')::numeric, 2) a, nullif(trim(r->>'description'), '') descr, nullif(trim(r->>'ref'), '') ref,
           nullif(r->>'kind', '') kind, nullif(r->>'external_id', '') ext,
           row_number() over (partition by r->>'date', r->>'amount', coalesce(r->>'ref', ''), lower(coalesce(r->>'description', '')) order by ord) dup
    from jsonb_array_elements(p_rows) with ordinality as x(r, ord)
  ), ins as (
    insert into bank_transactions(tenant_id, hotel_id, bank_account_id, posted_date, amount, description, ref, kind, source, import_id, external_id, fingerprint)
    select ba.tenant_id, ba.hotel_id, ba.id, d, a, descr, ref, kind, coalesce(p_meta->>'source', 'manual'), imp, ext,
           coalesce(ext, md5(d::text || '|' || a::text || '|' || coalesce(ref, '') || '|' || lower(coalesce(descr, '')) || '|' || dup))
    from src
    on conflict (bank_account_id, fingerprint) do nothing
    returning 1
  ) select count(*) into added from ins;
  update statement_imports set rows_added = added, duplicates = total - added where id = imp;
  if (p_meta->>'closing') is not null and (p_meta->>'to') is not null then
    update bank_accounts set balance = (p_meta->>'closing')::numeric, balance_as_of = (p_meta->>'to')::date
     where id = ba.id and (balance_as_of is null or balance_as_of <= (p_meta->>'to')::date);
  end if;
  rec := public.auto_reconcile(p_account);
  return jsonb_build_object('import_id', imp, 'read', total, 'added', added, 'duplicates', total - added) || rec;
end $$;

-- ---------- automatic reconciliation ----------
-- 1) a deposit equal to one expected deposit (±$0.01) within -1..+5 days
-- 2) a deposit equal to the same day's combined Visa/Mastercard/Discover batch
-- 3) an Amex deposit within 4% below expected (processing fee) — matched with variance
-- 4) a withdrawal equal to an approved/scheduled/paid bill (check number or amount, ±10 days)
create or replace function public.auto_reconcile(p_account uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare tx record; ed record; n1 int := 0; n2 int := 0; n3 int := 0; n4 int := 0; ba bank_accounts; b record; ids uuid[]; s numeric;
begin
  select * into ba from bank_accounts where id = p_account;
  for tx in select * from bank_transactions where bank_account_id = p_account and status = 'unmatched' and amount > 0 order by posted_date loop
    select * into ed from expected_deposits e where e.hotel_id = ba.hotel_id and e.status = 'open'
      and abs(e.amount - tx.amount) <= 0.01 and tx.posted_date between e.expected_date - 1 and e.expected_date + 5
      order by abs(tx.posted_date - e.expected_date), e.expected_date limit 1;
    if ed.id is not null then
      update expected_deposits set status = 'matched', bank_transaction_id = tx.id where id = ed.id;
      update bank_transactions set status = 'matched', matched_kind = 'deposit', matched_ids = array[ed.id], variance = 0 where id = tx.id;
      n1 := n1 + 1; continue;
    end if;
    select array_agg(e.id), sum(e.amount) into ids, s from expected_deposits e
      where e.hotel_id = ba.hotel_id and e.status = 'open' and e.source in ('visa','mastercard','discover')
        and e.expected_date = (select e2.expected_date from expected_deposits e2 where e2.hotel_id = ba.hotel_id and e2.status = 'open'
                               and e2.source in ('visa','mastercard','discover') and tx.posted_date between e2.expected_date - 1 and e2.expected_date + 5
                               group by e2.expected_date having abs(sum(e2.amount) - tx.amount) <= 0.01 order by abs(tx.posted_date - e2.expected_date) limit 1);
    if ids is not null then
      update expected_deposits set status = 'matched', bank_transaction_id = tx.id where id = any(ids);
      update bank_transactions set status = 'matched', matched_kind = 'deposit_batch', matched_ids = ids, variance = 0 where id = tx.id;
      n2 := n2 + 1; continue;
    end if;
    select * into ed from expected_deposits e where e.hotel_id = ba.hotel_id and e.status = 'open' and e.source = 'amex'
      and tx.amount between e.amount * 0.96 and e.amount and tx.posted_date between e.expected_date - 1 and e.expected_date + 5
      and (tx.description ilike '%amex%' or tx.description ilike '%american express%')
      order by abs(tx.posted_date - e.expected_date) limit 1;
    if ed.id is not null then
      update expected_deposits set status = 'matched', bank_transaction_id = tx.id where id = ed.id;
      update bank_transactions set status = 'matched', matched_kind = 'deposit_amex', matched_ids = array[ed.id], variance = round(tx.amount - ed.amount, 2),
        gl_account_id = public._gl(ba.tenant_id, '6010') where id = tx.id;
      n3 := n3 + 1;
    end if;
  end loop;
  for tx in select * from bank_transactions where bank_account_id = p_account and status = 'unmatched' and amount < 0 order by posted_date loop
    select bl.id, bl.status into b from bills bl
      where bl.hotel_id = ba.hotel_id and bl.status in ('approved','scheduled','paid') and abs(bl.amount + tx.amount) <= 0.01
        and not exists (select 1 from bank_transactions x where bl.id = any(x.matched_ids))
        and ((bl.payment_ref is not null and tx.ref is not null and bl.payment_ref = tx.ref)
             or tx.posted_date between coalesce(bl.paid_at, bl.scheduled_for, bl.due_date, tx.posted_date) - 10 and coalesce(bl.paid_at, bl.scheduled_for, bl.due_date, tx.posted_date) + 10)
      order by (bl.payment_ref is not distinct from tx.ref) desc limit 1;
    if b.id is not null then
      update bank_transactions set status = 'matched', matched_kind = 'bill', matched_ids = array[b.id], variance = 0 where id = tx.id;
      if b.status <> 'paid' then
        perform set_config('akea.approved_path', 'on', true);
        update bills set status = 'paid', paid_at = tx.posted_date where id = b.id;
      end if;
      n4 := n4 + 1;
    end if;
  end loop;
  return jsonb_build_object('matched_deposits', n1, 'matched_batches', n2, 'matched_amex', n3, 'matched_bills', n4);
end $$;

create or replace function public.match_transaction(p_tx uuid, p_kind text, p_ids uuid[], p_gl uuid default null) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if p_kind = 'exclude' then
    update bank_transactions set status = 'excluded', matched_kind = null, matched_ids = null where id = p_tx;
  elsif p_kind = 'unmatch' then
    update expected_deposits set status = 'open', bank_transaction_id = null where bank_transaction_id = p_tx;
    update bank_transactions set status = 'unmatched', matched_kind = null, matched_ids = null, variance = null where id = p_tx;
  elsif p_kind = 'deposit' then
    update expected_deposits set status = 'matched', bank_transaction_id = p_tx where id = any(p_ids);
    update bank_transactions t set status = 'matched', matched_kind = 'deposit', matched_ids = p_ids,
      variance = round(t.amount - (select coalesce(sum(amount), 0) from expected_deposits where id = any(p_ids)), 2) where id = p_tx;
  elsif p_kind = 'gl' then
    update bank_transactions set status = 'matched', matched_kind = 'gl', gl_account_id = p_gl, matched_ids = null where id = p_tx;
  else
    raise exception 'Unknown match type';
  end if;
end $$;

-- ---------- P&L: revenue from night audit, expenses from the ledger, budget alongside ----------
create or replace function public.pnl(p_from date, p_to date, p_hotels uuid[] default null)
returns table (section text, account text, number text, kind text, actual numeric, budget numeric, last_year numeric)
language sql stable security invoker set search_path = public as $$
  with h as (select id, tenant_id from hotels where (p_hotels is null or id = any(p_hotels)) and public.can_access_hotel(id)),
  rev as (
    select 'Revenue'::text sec, x.acct, x.num, 'revenue'::text k, sum(x.cur) cur, sum(x.ly) ly from (
      select '4000' num, 'Room Revenue' acct,
             sum(dm.room_revenue) filter (where dm.business_date between p_from and p_to) cur,
             sum(dm.room_revenue) filter (where dm.business_date between p_from - 364 and p_to - 364) ly
        from daily_metrics dm join h on h.id = dm.hotel_id
       where dm.business_date between p_from - 364 and p_to
      union all
      select '4100', 'Food & Beverage Revenue', sum(dm.fnb_revenue) filter (where dm.business_date between p_from and p_to),
             sum(dm.fnb_revenue) filter (where dm.business_date between p_from - 364 and p_to - 364)
        from daily_metrics dm join h on h.id = dm.hotel_id where dm.business_date between p_from - 364 and p_to
      union all
      select '4200', 'Other Operated Revenue', sum(dm.other_revenue) filter (where dm.business_date between p_from and p_to),
             sum(dm.other_revenue) filter (where dm.business_date between p_from - 364 and p_to - 364)
        from daily_metrics dm join h on h.id = dm.hotel_id where dm.business_date between p_from - 364 and p_to
    ) x group by 2, 3
  ),
  rev_b as (
    select '4000' num, sum(bd.room_revenue) b from budget_daily bd join h on h.id = bd.hotel_id where bd.business_date between p_from and p_to
    union all
    select '4200', sum(bd.total_revenue - bd.room_revenue) from budget_daily bd join h on h.id = bd.hotel_id where bd.business_date between p_from and p_to
  ),
  exp as (
    select a.section sec, a.name acct, a.number num, 'expense'::text k,
           sum(jl.debit - jl.credit) filter (where je.entry_date between p_from and p_to) cur,
           sum(jl.debit - jl.credit) filter (where je.entry_date between p_from - 364 and p_to - 364) ly
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join h on h.id = jl.hotel_id
    join gl_accounts a on a.id = jl.account_id
    where a.type = 'expense' and je.entry_date between p_from - 364 and p_to
    group by 1, 2, 3
  ),
  exp_b as (
    select a.number num, sum(bg.amount * (least(p_to, (bg.month + interval '1 month - 1 day')::date) - greatest(p_from, bg.month) + 1)::numeric
                             / ((bg.month + interval '1 month')::date - bg.month)) b
    from budget_gl bg join h on h.id = bg.hotel_id join gl_accounts a on a.id = bg.account_id
    where bg.month <= p_to and (bg.month + interval '1 month - 1 day')::date >= p_from and bg.version = 'Budget'
    group by 1
  )
  select r.sec, r.acct, r.num, r.k, round(coalesce(r.cur, 0), 2), round((select sum(b) from rev_b where rev_b.num = r.num), 2), round(r.ly, 2) from rev r
  union all
  select e.sec, e.acct, e.num, e.k, round(coalesce(e.cur, 0), 2), round((select b from exp_b where exp_b.num = e.num), 2), round(e.ly, 2) from exp e
  order by 4 desc, 3;
$$;

-- grants
do $$ declare f text; begin
  foreach f in array array['post_journal(uuid,date,text,jsonb,text,uuid)','decide_bill(uuid,boolean,text)','pay_bills(uuid[],uuid,text,date,text)',
    'decide_po(uuid,boolean,text)','advance_po(uuid,text)','import_bank_transactions(uuid,jsonb,jsonb)','auto_reconcile(uuid)',
    'match_transaction(uuid,text,uuid[],uuid)','pnl(date,date,uuid[])'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
