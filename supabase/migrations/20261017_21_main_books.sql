-- Accounting as the main books: bank transactions are reviewed and POSTED (each posting is a balanced journal entry),
-- bank rules categorise (and optionally post) new transactions, checks are written / printed / voided, the night audit
-- posts a daily revenue entry, and report balances come from the journal.
-- Every money path goes through security-definer functions; the tables can't be changed directly.

-- ---------------------------------------------------------------- journal core
-- post_journal checks the caller's rights; _post_journal_core is the same posting used by the platform's own functions
create or replace function public._post_journal_core(p_hotel uuid, p_date date, p_memo text, p_lines jsonb, p_source text default 'manual', p_source_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; jid uuid; dr numeric; cr numeric;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null then raise exception 'Hotel not found'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then raise exception 'An entry needs at least two lines'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where l->>'account_id' is null or public._hotel_gl(p_hotel, (l->>'account_id')::uuid) is null) then
    raise exception 'Every line needs an account from this hotel''s chart of accounts';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where coalesce((l->>'debit')::numeric, 0) < 0 or coalesce((l->>'credit')::numeric, 0) < 0) then
    raise exception 'Debits and credits cannot be negative';
  end if;
  select coalesce(sum((l->>'debit')::numeric), 0), coalesce(sum((l->>'credit')::numeric), 0) into dr, cr from jsonb_array_elements(p_lines) l;
  if round(dr, 2) <> round(cr, 2) or dr = 0 then raise exception 'Entry does not balance (debits %, credits %)', dr, cr; end if;
  if p_source_id is not null and p_source = 'manual' then
    select id into jid from journal_entries where hotel_id = p_hotel and source = p_source and source_id = p_source_id limit 1;
    if jid is not null then return jid; end if;
  end if;
  insert into journal_entries(tenant_id, hotel_id, entry_date, memo, source, source_id) values (t, p_hotel, p_date, p_memo, p_source, p_source_id) returning id into jid;
  insert into journal_lines(entry_id, tenant_id, hotel_id, account_id, debit, credit, memo)
  select jid, t, p_hotel, public._hotel_gl(p_hotel, (l->>'account_id')::uuid), round(coalesce((l->>'debit')::numeric, 0), 2), round(coalesce((l->>'credit')::numeric, 0), 2), l->>'memo'
  from jsonb_array_elements(p_lines) l
  where coalesce((l->>'debit')::numeric, 0) <> 0 or coalesce((l->>'credit')::numeric, 0) <> 0;
  return jid;
end $$;

create or replace function public.post_journal(p_hotel uuid, p_date date, p_memo text, p_lines jsonb, p_source text default 'manual', p_source_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null or not public.can_access_hotel(p_hotel) or public.perm_level(t, 'finance') < 2 then raise exception 'Not allowed'; end if;
  return public._post_journal_core(p_hotel, p_date, p_memo, p_lines, p_source, p_source_id);
end $$;

-- reverse an entry (once): same lines, debits and credits swapped
create or replace function public._reverse_journal(p_entry uuid, p_memo text, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare e journal_entries; jid uuid;
begin
  select * into e from journal_entries where id = p_entry;
  if e.id is null then return null; end if;
  select id into jid from journal_entries where source = 'void' and source_id = p_entry limit 1;
  if jid is not null then return jid; end if;
  return public._post_journal_core(e.hotel_id, greatest(p_date, e.entry_date), left(coalesce(p_memo, 'Reversal') || ' — ' || coalesce(e.memo, ''), 300),
    (select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.credit, 'credit', l.debit, 'memo', l.memo)) from journal_lines l where l.entry_id = p_entry),
    'void', p_entry);
end $$;
revoke execute on function public._post_journal_core(uuid, date, text, jsonb, text, uuid), public._reverse_journal(uuid, text, date) from public, anon, authenticated;

-- ---------------------------------------------------------------- bank transactions: review → post
alter table public.bank_transactions drop constraint if exists bank_transactions_status_check;
alter table public.bank_transactions add constraint bank_transactions_status_check check (status in ('unmatched', 'matched', 'posted', 'excluded'));
alter table public.bank_transactions add column if not exists txn_type text;
alter table public.bank_transactions add column if not exists vendor_id uuid references public.vendors(id) on delete set null;
alter table public.bank_transactions add column if not exists memo text;
alter table public.bank_transactions add column if not exists journal_entry_id uuid;
alter table public.bank_transactions add column if not exists posted_at timestamptz;
alter table public.bank_transactions add column if not exists posted_by uuid;
alter table public.bank_transactions add column if not exists rule_id uuid;
alter table public.bank_transactions add column if not exists attachment_path text;
alter table public.bank_transactions drop constraint if exists bank_transactions_txn_type;
alter table public.bank_transactions add constraint bank_transactions_txn_type check (txn_type is null or txn_type in ('expense', 'deposit', 'check', 'transfer', 'refund', 'other'));
alter table public.bank_transactions drop constraint if exists bank_transactions_attach_tenant;
alter table public.bank_transactions add constraint bank_transactions_attach_tenant check (attachment_path is null or split_part(attachment_path, '/', 1) = tenant_id::text);
create index if not exists bank_transactions_review on public.bank_transactions(bank_account_id, status, posted_date desc);
create index if not exists bank_transactions_vendor on public.bank_transactions(vendor_id) where vendor_id is not null;

-- direct edits: only the category fields, only while in review; status and money go through the functions below
create or replace function public._bank_tx_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') or coalesce(current_setting('akea.approved_path', true), '') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'unmatched' or new.journal_entry_id is not null or new.posted_at is not null then raise exception 'New bank transactions start in review'; end if;
    return new;
  end if;
  if new.amount is distinct from old.amount or new.posted_date is distinct from old.posted_date or new.bank_account_id is distinct from old.bank_account_id
     or new.status is distinct from old.status or new.journal_entry_id is distinct from old.journal_entry_id or new.posted_at is distinct from old.posted_at
     or new.posted_by is distinct from old.posted_by or new.matched_kind is distinct from old.matched_kind or new.matched_ids is distinct from old.matched_ids
     or new.rule_id is distinct from old.rule_id then
    raise exception 'Use Post, Undo, Match or Exclude for that';
  end if;
  if old.status = 'posted' and (new.gl_account_id is distinct from old.gl_account_id or new.vendor_id is distinct from old.vendor_id or new.txn_type is distinct from old.txn_type) then
    raise exception 'Undo the posted transaction before changing its category';
  end if;
  if new.vendor_id is distinct from old.vendor_id and new.vendor_id is not null
     and not exists (select 1 from vendors v where v.id = new.vendor_id and v.tenant_id = new.tenant_id) then raise exception 'Vendor not found'; end if;
  return new;
end $$;
create trigger bank_tx_guard before insert or update on public.bank_transactions for each row execute function public._bank_tx_guard();

-- post one transaction (no rights check — callers check)
create or replace function public._post_bank_txn(p_id uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare t bank_transactions; ba bank_accounts; bank_gl uuid; jid uuid; lines jsonb; expd numeric; v numeric; e record;
begin
  select * into t from bank_transactions where id = p_id for update;
  if t.id is null then raise exception 'Transaction not found'; end if;
  if t.status = 'posted' then return t.journal_entry_id; end if;
  if t.status = 'excluded' then raise exception 'An excluded transaction can''t be posted'; end if;
  if coalesce(t.amount, 0) = 0 then raise exception 'A zero-amount transaction can''t be posted (exclude it instead)'; end if;
  select * into ba from bank_accounts where id = t.bank_account_id;
  bank_gl := coalesce(ba.gl_account_id, public._gl_sys(t.hotel_id, 'cash'));
  if bank_gl is null then raise exception 'Link the bank account "%" to an account in the chart of accounts first', ba.name; end if;
  if t.matched_kind in ('bill', 'check') then
    -- the bill payment / check is already in the books; this just confirms it cleared the bank
    select j.id into jid from journal_entries j where j.source in ('payment', 'check') and j.source_id = any(t.matched_ids) order by j.created_at desc limit 1;
  elsif t.matched_kind in ('deposit', 'deposit_batch', 'deposit_amex') then
    lines := jsonb_build_array(jsonb_build_object('account_id', bank_gl, 'debit', t.amount, 'memo', t.description));
    for e in select source, sum(amount) amt from expected_deposits where id = any(t.matched_ids) group by source loop
      lines := lines || jsonb_build_object('account_id', case when e.source = 'direct_bill' then public._gl_sys(t.hotel_id, 'ar_direct_bill') else public._gl_sys(t.hotel_id, 'card_clearing') end,
                                           'credit', e.amt, 'memo', 'Deposit · ' || replace(e.source, '_', ' '));
    end loop;
    select coalesce(sum(amount), 0) into expd from expected_deposits where id = any(t.matched_ids);
    v := round(t.amount - expd, 2);
    if v < 0 then lines := lines || jsonb_build_object('account_id', public._gl_sys(t.hotel_id, 'card_fees'), 'debit', -v, 'memo', 'Card fees / short deposit');
    elsif v > 0 then lines := lines || jsonb_build_object('account_id', public._gl_sys(t.hotel_id, 'other_revenue'), 'credit', v, 'memo', 'Deposit over the night audit'); end if;
    jid := public._post_journal_core(t.hotel_id, t.posted_date, left(coalesce(t.description, 'Bank deposit'), 300), lines, 'bank', t.id);
  else
    if t.gl_account_id is null then raise exception 'Choose a category for "%" (%)', coalesce(t.description, 'transaction'), t.amount; end if;
    if t.amount < 0 then
      lines := jsonb_build_array(jsonb_build_object('account_id', t.gl_account_id, 'debit', -t.amount, 'memo', coalesce(t.memo, t.description)),
                                 jsonb_build_object('account_id', bank_gl, 'credit', -t.amount, 'memo', t.description));
    else
      lines := jsonb_build_array(jsonb_build_object('account_id', bank_gl, 'debit', t.amount, 'memo', t.description),
                                 jsonb_build_object('account_id', t.gl_account_id, 'credit', t.amount, 'memo', coalesce(t.memo, t.description)));
    end if;
    jid := public._post_journal_core(t.hotel_id, t.posted_date, left(coalesce(t.memo, t.description, 'Bank transaction'), 300), lines, 'bank', t.id);
  end if;
  perform set_config('akea.approved_path', 'on', true);
  update bank_transactions set status = 'posted', journal_entry_id = jid, posted_at = now(), posted_by = auth.uid() where id = t.id;
  return jid;
end $$;
revoke execute on function public._post_bank_txn(uuid) from public, anon, authenticated;

-- rights for a list of transactions (finance edit at each hotel)
create or replace function public._bank_tx_allowed(p_id uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from bank_transactions t where t.id = p_id and public.can_access_hotel(t.hotel_id) and public.perm_level(t.tenant_id, 'finance') >= 2)
$$;
revoke execute on function public._bank_tx_allowed(uuid) from public, anon;

-- Post (bulk). Each one is posted on its own; the result lists any that need attention.
create or replace function public.post_bank_transactions(p_ids uuid[]) returns jsonb language plpgsql security definer set search_path = public as $$
declare i uuid; ok int := 0; bad jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_ids), 0) > 500 then raise exception 'Post up to 500 at a time'; end if;
  foreach i in array coalesce(p_ids, '{}') loop
    if not public._bank_tx_allowed(i) then bad := bad || jsonb_build_object('id', i, 'error', 'Not allowed'); continue; end if;
    begin
      perform public._post_bank_txn(i); ok := ok + 1;
    exception when others then bad := bad || jsonb_build_object('id', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('posted', ok, 'failed', bad);
end $$;

-- Edit selected (bulk): set any of type / payee / category / memo; optionally post ("Apply and post")
create or replace function public.categorize_bank_transactions(p_ids uuid[], p_type text default null, p_vendor uuid default null, p_gl uuid default null,
  p_memo text default null, p_post boolean default false) returns jsonb language plpgsql security definer set search_path = public as $$
declare t bank_transactions; g uuid; ok int := 0; posted int := 0; bad jsonb := '[]'::jsonb; act boolean;
begin
  if coalesce(cardinality(p_ids), 0) > 500 then raise exception 'Edit up to 500 at a time'; end if;
  if p_type is not null and p_type not in ('expense', 'deposit', 'check', 'transfer', 'refund', 'other') then raise exception 'Unknown transaction type'; end if;
  for t in select * from bank_transactions where id = any(p_ids) order by posted_date loop
    if not public._bank_tx_allowed(t.id) then bad := bad || jsonb_build_object('id', t.id, 'error', 'Not allowed'); continue; end if;
    if t.status not in ('unmatched', 'matched') or (t.status = 'matched' and coalesce(t.matched_kind, 'gl') <> 'gl') then
      bad := bad || jsonb_build_object('id', t.id, 'error', case when t.status = 'posted' then 'Already posted (undo it first)' when t.status = 'excluded' then 'Excluded' else 'Matched to a deposit or payment' end);
      continue;
    end if;
    g := null;
    if p_gl is not null then
      g := public._hotel_gl(t.hotel_id, p_gl);
      select case when active then g end into g from gl_accounts where id = g;
      if g is null then bad := bad || jsonb_build_object('id', t.id, 'error', 'That account isn''t in this hotel''s chart (or is inactive)'); continue; end if;
    end if;
    if p_vendor is not null and not exists (select 1 from vendors v where v.id = p_vendor and v.tenant_id = t.tenant_id) then raise exception 'Vendor not found'; end if;
    perform set_config('akea.approved_path', 'on', true);
    update bank_transactions set txn_type = coalesce(p_type, txn_type), vendor_id = coalesce(p_vendor, vendor_id), gl_account_id = coalesce(g, gl_account_id),
      memo = coalesce(nullif(btrim(p_memo), ''), memo), matched_kind = case when g is not null then 'gl' else matched_kind end, status = 'unmatched'
    where id = t.id;
    ok := ok + 1;
    if p_post then
      begin perform public._post_bank_txn(t.id); posted := posted + 1;
      exception when others then bad := bad || jsonb_build_object('id', t.id, 'error', sqlerrm); end;
    end if;
  end loop;
  return jsonb_build_object('updated', ok, 'posted', posted, 'failed', bad);
end $$;

-- Exclude (duplicates, transfers already recorded, personal) and Restore
create or replace function public.exclude_bank_transactions(p_ids uuid[], p_exclude boolean default true) returns int language plpgsql security definer set search_path = public as $$
declare t bank_transactions; n int := 0;
begin
  for t in select * from bank_transactions where id = any(p_ids) loop
    if not public._bank_tx_allowed(t.id) then raise exception 'Not allowed'; end if;
    perform set_config('akea.approved_path', 'on', true);
    if p_exclude and t.status in ('unmatched', 'matched') then
      update expected_deposits set status = 'open', bank_transaction_id = null where bank_transaction_id = t.id;
      update bank_transactions set status = 'excluded', matched_kind = null, matched_ids = null, variance = null where id = t.id; n := n + 1;
    elsif not p_exclude and t.status = 'excluded' then
      update bank_transactions set status = 'unmatched' where id = t.id; n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Undo a posting: the journal entry is reversed and the transaction goes back to review
create or replace function public.undo_bank_transactions(p_ids uuid[]) returns int language plpgsql security definer set search_path = public as $$
declare t bank_transactions; n int := 0;
begin
  for t in select * from bank_transactions where id = any(p_ids) for update loop
    if not public._bank_tx_allowed(t.id) then raise exception 'Not allowed'; end if;
    perform set_config('akea.approved_path', 'on', true);
    if t.status = 'posted' then
      if t.journal_entry_id is not null and exists (select 1 from journal_entries j where j.id = t.journal_entry_id and j.source = 'bank') then
        perform public._reverse_journal(t.journal_entry_id, 'Undo bank posting');
      end if;
      update bank_transactions set status = case when matched_kind in ('deposit', 'deposit_batch', 'deposit_amex', 'bill', 'check') then 'matched' else 'unmatched' end,
        journal_entry_id = null, posted_at = null, posted_by = null where id = t.id;
      n := n + 1;
    elsif t.status = 'matched' then
      update expected_deposits set status = 'open', bank_transaction_id = null where bank_transaction_id = t.id;
      update bank_transactions set status = 'unmatched', matched_kind = case when gl_account_id is not null then 'gl' end, matched_ids = null, variance = null where id = t.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- the older single-transaction actions, kept for the reconcile screen
create or replace function public.match_transaction(p_tx uuid, p_kind text, p_ids uuid[], p_gl uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare t bank_transactions;
begin
  select * into t from bank_transactions where id = p_tx;
  if t.id is null or not public._bank_tx_allowed(p_tx) then raise exception 'Not allowed'; end if;
  if t.status = 'posted' then raise exception 'Undo the posting first'; end if;
  perform set_config('akea.approved_path', 'on', true);
  if p_kind = 'exclude' then perform public.exclude_bank_transactions(array[p_tx], true);
  elsif p_kind = 'unmatch' then perform public.undo_bank_transactions(array[p_tx]);
  elsif p_kind = 'deposit' then
    if exists (select 1 from expected_deposits e where e.id = any(p_ids) and (e.hotel_id <> t.hotel_id or e.status <> 'open')) then raise exception 'Those deposits aren''t open for this hotel'; end if;
    update expected_deposits set status = 'matched', bank_transaction_id = p_tx where id = any(p_ids);
    update bank_transactions b set status = 'matched', matched_kind = 'deposit', matched_ids = p_ids,
      variance = round(b.amount - (select coalesce(sum(amount), 0) from expected_deposits where id = any(p_ids)), 2) where id = p_tx;
  elsif p_kind = 'gl' then perform public.categorize_bank_transactions(array[p_tx], null, null, p_gl, null, false);
  else raise exception 'Unknown match type';
  end if;
end $$;

-- ---------------------------------------------------------------- bank rules
create table if not exists public.bank_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  priority int not null default 100,
  bank_account_ids uuid[],                                   -- empty = every bank account of the hotel
  direction text not null default 'any' check (direction in ('in', 'out', 'any')),
  match_all boolean not null default true,                   -- all conditions vs any condition
  conditions jsonb not null default '[]'::jsonb,             -- [{field:'description'|'amount', op, value, value2}]
  set_type text check (set_type is null or set_type in ('expense', 'deposit', 'check', 'transfer', 'refund', 'other')),
  set_vendor_id uuid references public.vendors(id) on delete set null,
  set_gl_account_id uuid references public.gl_accounts(id),
  set_memo text,
  auto_post boolean not null default false,
  active boolean not null default true,
  applied_count int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists bank_rules_hotel on public.bank_rules(hotel_id, priority);
alter table public.bank_rules enable row level security;
create policy bank_rules_read on public.bank_rules for select to authenticated using (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'finance') >= 1);
create policy bank_rules_write on public.bank_rules for all to authenticated
  using (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'finance') >= 2)
  with check (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'finance') >= 2);
create trigger bank_rules_hotel_tenant before insert or update of hotel_id, tenant_id on public.bank_rules for each row execute function public._hotel_tenant_match();
create trigger bank_rules_same_hotel before insert or update on public.bank_rules for each row execute function public._same_hotel('set_gl_account_id:gl_accounts');

create or replace function public._bank_rule_check() returns trigger language plpgsql set search_path = public as $$
declare c jsonb;
begin
  if jsonb_typeof(new.conditions) <> 'array' or jsonb_array_length(new.conditions) = 0 then raise exception 'Add at least one condition'; end if;
  if jsonb_array_length(new.conditions) > 10 then raise exception 'Up to 10 conditions per rule'; end if;
  for c in select * from jsonb_array_elements(new.conditions) loop
    if c->>'field' = 'description' then
      if coalesce(c->>'op', '') not in ('contains', 'not_contains', 'is', 'starts') or coalesce(btrim(c->>'value'), '') = '' then raise exception 'Each description condition needs text'; end if;
    elsif c->>'field' = 'amount' then
      if coalesce(c->>'op', '') not in ('eq', 'gt', 'lt', 'between') or (c->>'value') !~ '^\d+(\.\d+)?$'
         or (c->>'op' = 'between' and coalesce(c->>'value2', '') !~ '^\d+(\.\d+)?$') then raise exception 'Each amount condition needs a number'; end if;
    else raise exception 'Conditions can check the description or the amount';
    end if;
  end loop;
  if new.set_gl_account_id is null and new.set_vendor_id is null and new.set_type is null then raise exception 'A rule needs something to set (category, payee or type)'; end if;
  if new.auto_post and new.set_gl_account_id is null then raise exception 'Auto-post needs a category'; end if;
  if new.set_vendor_id is not null and not exists (select 1 from vendors v where v.id = new.set_vendor_id and v.tenant_id = new.tenant_id) then raise exception 'Vendor not found'; end if;
  if tg_op = 'INSERT' or new.bank_account_ids is distinct from old.bank_account_ids then
    if exists (select 1 from unnest(coalesce(new.bank_account_ids, '{}')) x where not exists (select 1 from bank_accounts b where b.id = x and b.hotel_id = new.hotel_id)) then
      raise exception 'A rule can only use this hotel''s bank accounts';
    end if;
  end if;
  return new;
end $$;
create trigger bank_rules_check before insert or update on public.bank_rules for each row execute function public._bank_rule_check();

create or replace function public._rule_matches(r bank_rules, t bank_transactions) returns boolean language plpgsql stable set search_path = public as $$
declare c jsonb; ok boolean; hits int := 0; n int := 0; v text; d text := lower(coalesce(t.description, '') || ' ' || coalesce(t.ref, '')); a numeric := abs(t.amount);
begin
  if r.direction = 'in' and t.amount <= 0 then return false; end if;
  if r.direction = 'out' and t.amount >= 0 then return false; end if;
  if coalesce(cardinality(r.bank_account_ids), 0) > 0 and not (t.bank_account_id = any(r.bank_account_ids)) then return false; end if;
  for c in select * from jsonb_array_elements(r.conditions) loop
    n := n + 1; v := lower(coalesce(c->>'value', ''));
    ok := case when c->>'field' = 'description' then
                 case c->>'op' when 'contains' then position(v in d) > 0 when 'not_contains' then position(v in d) = 0
                               when 'is' then lower(btrim(coalesce(t.description, ''))) = btrim(v) when 'starts' then lower(coalesce(t.description, '')) like replace(replace(v, '%', '\%'), '_', '\_') || '%' else false end
               when c->>'field' = 'amount' then
                 case c->>'op' when 'eq' then a = (c->>'value')::numeric when 'gt' then a > (c->>'value')::numeric when 'lt' then a < (c->>'value')::numeric
                               when 'between' then a between (c->>'value')::numeric and (c->>'value2')::numeric else false end
               else false end;
    if ok then hits := hits + 1; elsif r.match_all then return false; end if;
  end loop;
  return n > 0 and hits > 0;
end $$;

-- categorise review items by the first matching rule (by priority); auto-post where the rule says so
create or replace function public._apply_rules(p_account uuid) returns int language plpgsql security definer set search_path = public as $$
declare t bank_transactions; r bank_rules; g uuid; n int := 0;
begin
  for t in select * from bank_transactions where bank_account_id = p_account and status = 'unmatched' and coalesce(matched_kind, 'gl') = 'gl'
           and gl_account_id is null and rule_id is null order by posted_date loop
    select * into r from bank_rules x where x.hotel_id = t.hotel_id and x.active and public._rule_matches(x, t) order by x.priority, x.created_at limit 1;
    continue when r.id is null;
    g := case when r.set_gl_account_id is not null then public._hotel_gl(t.hotel_id, r.set_gl_account_id) end;
    perform set_config('akea.approved_path', 'on', true);
    update bank_transactions set txn_type = coalesce(r.set_type, txn_type), vendor_id = coalesce(r.set_vendor_id, vendor_id), gl_account_id = coalesce(g, gl_account_id),
      memo = coalesce(r.set_memo, memo), rule_id = r.id, matched_kind = case when g is not null then 'gl' end where id = t.id;
    update bank_rules set applied_count = applied_count + 1 where id = r.id;
    n := n + 1;
    if r.auto_post and g is not null then
      begin perform public._post_bank_txn(t.id); exception when others then null; end;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public._apply_rules(uuid) from public, anon, authenticated;

create or replace function public.apply_bank_rules(p_account uuid) returns int language plpgsql security definer set search_path = public as $$
declare ba bank_accounts;
begin
  select * into ba from bank_accounts where id = p_account;
  if ba.id is null or not public.can_access_hotel(ba.hotel_id) or public.perm_level(ba.tenant_id, 'finance') < 2 then raise exception 'Not allowed'; end if;
  return public._apply_rules(p_account);
end $$;

-- ---------------------------------------------------------------- checks (pre-printed stock)
alter table public.bank_accounts add column if not exists next_check_number int not null default 1001;
alter table public.bank_accounts add column if not exists check_layout text not null default 'voucher_top';
alter table public.bank_accounts add column if not exists check_offset_x numeric not null default 0;   -- printer alignment, inches
alter table public.bank_accounts add column if not exists check_offset_y numeric not null default 0;
alter table public.bank_accounts add column if not exists check_print_company boolean not null default true;
alter table public.bank_accounts drop constraint if exists bank_accounts_check_layout;
alter table public.bank_accounts add constraint bank_accounts_check_layout check (check_layout in ('voucher_top', 'voucher_middle', 'voucher_bottom', 'standard3'));
alter table public.bank_accounts drop constraint if exists bank_accounts_check_offsets;
alter table public.bank_accounts add constraint bank_accounts_check_offsets check (abs(check_offset_x) <= 1 and abs(check_offset_y) <= 1 and next_check_number between 1 and 99999999);

create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),
  check_number int,
  check_date date not null,
  payee_vendor_id uuid references public.vendors(id) on delete set null,
  payee_name text not null,
  payee_address text,
  amount numeric(12,2) not null check (amount > 0 and amount < 10000000),
  memo text,
  lines jsonb,                     -- expense checks: [{account_id, amount, memo}]
  bill_ids uuid[],                 -- bill payment checks
  status text not null default 'to_print' check (status in ('to_print', 'printed', 'voided')),
  printed_at timestamptz, printed_by uuid,
  journal_entry_id uuid,
  voided_at timestamptz, voided_by uuid, void_reason text,
  created_by uuid default auth.uid(), created_at timestamptz not null default now()
);
create unique index if not exists checks_number on public.checks(bank_account_id, check_number) where check_number is not null;
create index if not exists checks_hotel on public.checks(hotel_id, status, check_date desc);
alter table public.checks enable row level security;
create policy checks_read on public.checks for select to authenticated using (public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'finance') >= 1);
revoke insert, update, delete on public.checks from authenticated, anon;
create trigger checks_hotel_tenant before insert or update of hotel_id, tenant_id on public.checks for each row execute function public._hotel_tenant_match();
create trigger checks_same_hotel before insert or update on public.checks for each row execute function public._same_hotel('bank_account_id:bank_accounts');

create or replace function public._check_bank(p_bank uuid) returns bank_accounts language plpgsql stable security definer set search_path = public as $$
declare ba bank_accounts;
begin
  select * into ba from bank_accounts where id = p_bank;
  if ba.id is null or not public.can_access_hotel(ba.hotel_id) then raise exception 'Bank account not found'; end if;
  if public.perm_level(ba.tenant_id, 'finance') < 3 then raise exception 'Writing and printing checks needs finance approval rights'; end if;
  return ba;
end $$;
revoke execute on function public._check_bank(uuid) from public, anon, authenticated;

-- write a check for expenses (lines). With a number it's a hand-written check (already printed); without, it waits in the print queue.
create or replace function public.write_check(p_bank uuid, p_date date, p_vendor uuid, p_payee text, p_address text, p_memo text, p_lines jsonb, p_number int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare ba bank_accounts; v vendors; cid uuid; jid uuid; tot numeric; jl jsonb := '[]'::jsonb; l jsonb; g uuid; payee text;
begin
  ba := public._check_bank(p_bank);
  if p_vendor is not null then
    select * into v from vendors where id = p_vendor and tenant_id = ba.tenant_id;
    if v.id is null then raise exception 'Vendor not found'; end if;
  end if;
  payee := btrim(coalesce(nullif(btrim(p_payee), ''), v.name, ''));
  if payee = '' then raise exception 'Enter who the check is payable to'; end if;
  if char_length(payee) > 120 then raise exception 'Payee name is too long'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 30 then raise exception 'Add 1 to 30 expense lines'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    g := public._hotel_gl(ba.hotel_id, (l->>'account_id')::uuid);
    if g is null then raise exception 'Every line needs an account from this hotel''s chart'; end if;
    if coalesce((l->>'amount')::numeric, 0) <= 0 then raise exception 'Line amounts must be more than zero'; end if;
    jl := jl || jsonb_build_object('account_id', g, 'debit', round((l->>'amount')::numeric, 2), 'memo', left(l->>'memo', 200));
  end loop;
  select round(sum((x->>'debit')::numeric), 2) into tot from jsonb_array_elements(jl) x;
  if p_number is not null and exists (select 1 from checks where bank_account_id = ba.id and check_number = p_number) then raise exception 'Check % is already used on this account', p_number; end if;
  insert into checks(tenant_id, hotel_id, bank_account_id, check_number, check_date, payee_vendor_id, payee_name, payee_address, amount, memo, lines, status, printed_at, printed_by)
  values (ba.tenant_id, ba.hotel_id, ba.id, p_number, coalesce(p_date, current_date), p_vendor, payee, nullif(btrim(coalesce(p_address, v.address, '')), ''), tot,
          nullif(btrim(p_memo), ''), jl, case when p_number is null then 'to_print' else 'printed' end,
          case when p_number is not null then now() end, case when p_number is not null then auth.uid() end)
  returning id into cid;
  jid := public._post_journal_core(ba.hotel_id, coalesce(p_date, current_date), left('Check' || coalesce(' ' || p_number, '') || ' · ' || payee, 300),
           jl || jsonb_build_object('account_id', coalesce(ba.gl_account_id, public._gl_sys(ba.hotel_id, 'cash')), 'credit', tot, 'memo', payee), 'check', cid);
  update checks set journal_entry_id = jid where id = cid;
  if p_number is not null then update bank_accounts set next_check_number = greatest(next_check_number, p_number + 1) where id = ba.id; end if;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail) values (ba.tenant_id, auth.uid(), 'write', 'check', cid::text, jsonb_build_object('amount', tot, 'payee', payee));
  return cid;
end $$;

-- pay approved bills by check: one check per vendor, queued for printing
create or replace function public.pay_bills_by_check(p_ids uuid[], p_bank uuid, p_date date) returns int language plpgsql security definer set search_path = public as $$
declare ba bank_accounts; g record; n int := 0;
begin
  ba := public._check_bank(p_bank);
  perform public.pay_bills(p_ids, p_bank, 'check', coalesce(p_date, current_date), null);
  for g in select b.vendor_id, array_agg(b.id order by b.invoice_date) ids, sum(b.amount) amt, string_agg(coalesce(b.invoice_no, ''), ', ' order by b.invoice_date) inv
           from bills b where b.id = any(p_ids) group by b.vendor_id loop
    insert into checks(tenant_id, hotel_id, bank_account_id, check_date, payee_vendor_id, payee_name, payee_address, amount, memo, bill_ids)
    select ba.tenant_id, ba.hotel_id, ba.id, coalesce(p_date, current_date), g.vendor_id, coalesce(v.name, 'Vendor'), v.address, g.amt,
           left(nullif('Invoices ' || g.inv, 'Invoices '), 200), g.ids
    from (select 1) one left join vendors v on v.id = g.vendor_id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- after printing: the checks that came out right get their numbers (in print order)
create or replace function public.mark_checks_printed(p_ids uuid[], p_first int) returns int language plpgsql security definer set search_path = public as $$
declare c checks; ba bank_accounts; i int := 0; num int;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then return 0; end if;
  if p_first is null or p_first < 1 then raise exception 'Enter the first check number'; end if;
  select b.* into ba from bank_accounts b join checks k on k.bank_account_id = b.id where k.id = p_ids[1];
  ba := public._check_bank(ba.id);
  if exists (select 1 from checks where id = any(p_ids) and (bank_account_id <> ba.id or status <> 'to_print')) then raise exception 'Print one bank account''s queued checks at a time'; end if;
  for c in select k.* from unnest(p_ids) with ordinality u(id, ord) join checks k on k.id = u.id order by u.ord loop
    num := p_first + i;
    if exists (select 1 from checks where bank_account_id = ba.id and check_number = num) then raise exception 'Check number % is already used on this account', num; end if;
    update checks set check_number = num, status = 'printed', printed_at = now(), printed_by = auth.uid() where id = c.id;
    if c.bill_ids is not null then
      perform set_config('akea.approved_path', 'on', true);
      update bills set payment_ref = 'Check ' || num where id = any(c.bill_ids);
    end if;
    if c.journal_entry_id is not null then update journal_entries set memo = left('Check ' || num || ' · ' || c.payee_name, 300) where id = c.journal_entry_id; end if;
    i := i + 1;
  end loop;
  update bank_accounts set next_check_number = greatest(next_check_number, p_first + i) where id = ba.id;
  return i;
end $$;

-- back into the print queue (printer jam, wrong paper) — only before it has cleared the bank
create or replace function public.requeue_checks(p_ids uuid[]) returns int language plpgsql security definer set search_path = public as $$
declare c checks; n int := 0;
begin
  for c in select * from checks where id = any(p_ids) loop
    perform public._check_bank(c.bank_account_id);
    if c.status <> 'printed' then continue; end if;
    if exists (select 1 from bank_transactions t where t.matched_kind = 'check' and c.id = any(t.matched_ids)) then raise exception 'Check % has cleared the bank', c.check_number; end if;
    update checks set status = 'to_print', check_number = null, printed_at = null, printed_by = null where id = c.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.void_check(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare c checks; j record;
begin
  select * into c from checks where id = p_id for update;
  if c.id is null then raise exception 'Check not found'; end if;
  perform public._check_bank(c.bank_account_id);
  if c.status = 'voided' then return; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Enter the reason for voiding'; end if;
  if exists (select 1 from bank_transactions t where t.matched_kind = 'check' and c.id = any(t.matched_ids) and t.status in ('matched', 'posted')) then
    raise exception 'This check has cleared the bank. Undo the bank match first.';
  end if;
  if c.journal_entry_id is not null then perform public._reverse_journal(c.journal_entry_id, 'Void check ' || coalesce(c.check_number::text, '')); end if;
  if c.bill_ids is not null then
    for j in select je.id from journal_entries je where je.source = 'payment' and je.source_id = any(c.bill_ids)
             and not exists (select 1 from journal_entries x where x.source = 'void' and x.source_id = je.id) loop
      perform public._reverse_journal(j.id, 'Void check ' || coalesce(c.check_number::text, ''));
    end loop;
    perform set_config('akea.approved_path', 'on', true);
    update bills set status = 'approved', paid_at = null, scheduled_for = null, payment_method = null, payment_ref = null where id = any(c.bill_ids) and status in ('paid', 'scheduled');
  end if;
  update checks set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300) where id = c.id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (c.tenant_id, auth.uid(), 'void', 'check', c.id::text, jsonb_build_object('number', c.check_number, 'amount', c.amount, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------- auto-match (now also checks) + rules
create or replace function public.auto_reconcile(p_account uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare tx record; ed record; n1 int := 0; n2 int := 0; n3 int := 0; n4 int := 0; n5 int := 0; nr int := 0; ba bank_accounts; b record; ids uuid[]; s numeric; ck record;
begin
  select * into ba from bank_accounts where id = p_account;
  if ba.id is null then raise exception 'Bank account not found'; end if;
  -- people need finance edit rights at the hotel; the bank-feed service (no signed-in user) runs it for every account
  if auth.uid() is not null and (not public.can_access_hotel(ba.hotel_id) or public.perm_level(ba.tenant_id, 'finance') < 2) then raise exception 'Not allowed'; end if;
  perform set_config('akea.approved_path', 'on', true);
  for tx in select * from bank_transactions where bank_account_id = p_account and status = 'unmatched' and matched_kind is null and amount > 0 order by posted_date loop
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
      update bank_transactions set status = 'matched', matched_kind = 'deposit_amex', matched_ids = array[ed.id], variance = round(tx.amount - ed.amount, 2) where id = tx.id;
      n3 := n3 + 1;
    end if;
  end loop;
  for tx in select * from bank_transactions where bank_account_id = p_account and status = 'unmatched' and matched_kind is null and amount < 0 order by posted_date loop
    -- a printed check that cleared: same amount and its number in the reference or description
    select k.id, k.check_number into ck from checks k
      where k.bank_account_id = p_account and k.status = 'printed' and k.check_number is not null and k.amount = -tx.amount
        and not exists (select 1 from bank_transactions x where x.matched_kind = 'check' and k.id = any(x.matched_ids))
        and ((tx.ref ~ '^\d{1,9}$' and tx.ref::bigint = k.check_number) or tx.description ~* ('(check|chk|ck)\s*#?\s*0*' || k.check_number || '\M'))
      limit 1;
    if ck.id is not null then
      update bank_transactions set status = 'matched', matched_kind = 'check', matched_ids = array[ck.id], variance = 0 where id = tx.id;
      n5 := n5 + 1; continue;
    end if;
    select bl.id, bl.status, bl.amount, bl.invoice_no into b from bills bl
      where bl.hotel_id = ba.hotel_id and bl.status in ('approved','scheduled','paid') and abs(bl.amount + tx.amount) <= 0.01
        and coalesce(bl.payment_method, '') <> 'check'
        and not exists (select 1 from bank_transactions x where bl.id = any(x.matched_ids))
        and ((bl.payment_ref is not null and tx.ref is not null and bl.payment_ref = tx.ref)
             or tx.posted_date between coalesce(bl.paid_at, bl.scheduled_for, bl.due_date, tx.posted_date) - 10 and coalesce(bl.paid_at, bl.scheduled_for, bl.due_date, tx.posted_date) + 10)
      order by (bl.payment_ref is not distinct from tx.ref) desc limit 1;
    if b.id is not null then
      update bank_transactions set status = 'matched', matched_kind = 'bill', matched_ids = array[b.id], variance = 0 where id = tx.id;
      if b.status <> 'paid' then
        update bills set status = 'paid', paid_at = tx.posted_date, bank_account_id = coalesce(bank_account_id, ba.id) where id = b.id;
        if not exists (select 1 from journal_entries j where j.source = 'payment' and j.source_id = b.id) then
          perform public._post_journal_core(ba.hotel_id, tx.posted_date, 'Payment ' || coalesce(b.invoice_no, '') || ' (cleared the bank)',
            jsonb_build_array(jsonb_build_object('account_id', public._gl_sys(ba.hotel_id, 'ap'), 'debit', b.amount),
                              jsonb_build_object('account_id', coalesce(ba.gl_account_id, public._gl_sys(ba.hotel_id, 'cash')), 'credit', b.amount)), 'payment', b.id);
        end if;
      end if;
      n4 := n4 + 1;
    end if;
  end loop;
  nr := public._apply_rules(p_account);
  return jsonb_build_object('matched_deposits', n1, 'matched_batches', n2, 'matched_amex', n3, 'matched_bills', n4, 'matched_checks', n5, 'rules_applied', nr);
end $$;

-- ---------------------------------------------------------------- daily revenue entry from the night audit
-- Dr Guest Ledger (all charges) / Cr revenue + tax; Dr Card Clearing (cards, cash, OTA) and A/R Direct Bill / Cr Guest Ledger (payments).
-- Re-reading the same night replaces the entry. Sample data never posts.
create or replace function public._post_daily_revenue(p_hotel uuid, p_date date) returns uuid language plpgsql security definer set search_path = public as $$
declare dm daily_metrics; old record; lines jsonb := '[]'::jsonb; charges numeric; pay_card numeric; pay_db numeric;
  add_cr text := 'credit';
begin
  select * into dm from daily_metrics where hotel_id = p_hotel and business_date = p_date;
  if dm.hotel_id is null or dm.data_source <> 'report' then return null; end if;
  for old in select j.id from journal_entries j where j.hotel_id = p_hotel and j.source = 'revenue' and j.entry_date = p_date
               and not exists (select 1 from journal_entries x where x.source = 'void' and x.source_id = j.id) loop
    perform public._reverse_journal(old.id, 'Replaced by the latest night audit', p_date);
  end loop;
  charges := round(coalesce(dm.room_revenue, 0) + coalesce(dm.fnb_revenue, 0) + coalesce(dm.other_revenue, 0) + coalesce(dm.tax_total, 0), 2);
  select round(coalesce(sum(amount) filter (where source <> 'direct_bill'), 0), 2), round(coalesce(sum(amount) filter (where source = 'direct_bill'), 0), 2)
    into pay_card, pay_db from expected_deposits
   where hotel_id = p_hotel and business_date = p_date and status <> 'written_off' and (dm.source_report_id is null or report_id = dm.source_report_id);
  -- a negative figure moves to the other side
  lines := jsonb_build_array(
    jsonb_build_object('account_id', public._gl_sys(p_hotel, 'guest_ledger'), 'debit', greatest(charges, 0), 'credit', greatest(-charges, 0), 'memo', 'Charges'),
    jsonb_build_object('account_id', public._gl_sys(p_hotel, 'room_revenue'), 'credit', greatest(coalesce(dm.room_revenue, 0), 0), 'debit', greatest(-coalesce(dm.room_revenue, 0), 0)),
    jsonb_build_object('account_id', public._gl_sys(p_hotel, 'fnb_revenue'), 'credit', greatest(coalesce(dm.fnb_revenue, 0), 0), 'debit', greatest(-coalesce(dm.fnb_revenue, 0), 0)),
    jsonb_build_object('account_id', public._gl_sys(p_hotel, 'other_revenue'), 'credit', greatest(coalesce(dm.other_revenue, 0), 0), 'debit', greatest(-coalesce(dm.other_revenue, 0), 0)),
    jsonb_build_object('account_id', public._gl_sys(p_hotel, 'sales_tax'), 'credit', greatest(coalesce(dm.tax_total, 0), 0), 'debit', greatest(-coalesce(dm.tax_total, 0), 0)));
  if pay_card + pay_db <> 0 then
    lines := lines || jsonb_build_array(
      jsonb_build_object('account_id', public._gl_sys(p_hotel, 'card_clearing'), 'debit', pay_card, 'memo', 'Card, cash and OTA payments'),
      jsonb_build_object('account_id', public._gl_sys(p_hotel, 'ar_direct_bill'), 'debit', pay_db, 'memo', 'Moved to direct bill'),
      jsonb_build_object('account_id', public._gl_sys(p_hotel, 'guest_ledger'), 'credit', pay_card + pay_db, 'memo', 'Payments'));
  end if;
  if charges = 0 and pay_card + pay_db = 0 then return null; end if;
  return public._post_journal_core(p_hotel, p_date, 'Night audit · ' || to_char(p_date, 'Mon DD, YYYY'), lines, 'revenue', dm.source_report_id);
end $$;
revoke execute on function public._post_daily_revenue(uuid, date) from public, anon, authenticated;

-- post it whenever a night audit is read (failures never block reading the report)
create or replace function public._ingest_extras(r reports, p_extra jsonb) returns void language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if p_extra is not null then
    if p_extra ? 'tax_total' then
      update daily_metrics set tax_total = (p_extra->>'tax_total')::numeric where hotel_id = r.hotel_id and business_date = r.business_date;
    end if;
    for k in select jsonb_object_keys(coalesce(p_extra->'periods', '{}'::jsonb)) loop
      insert into report_stats(hotel_id, business_date, period, rooms_available, rooms_sold, room_revenue, total_revenue, source_report_id)
      values (r.hotel_id, r.business_date, k, (p_extra->'periods'->k->>'rooms_available')::numeric, (p_extra->'periods'->k->>'rooms_sold')::numeric,
              (p_extra->'periods'->k->>'room_revenue')::numeric, (p_extra->'periods'->k->>'total_revenue')::numeric, r.id)
      on conflict (hotel_id, business_date, period) do update set rooms_available = excluded.rooms_available, rooms_sold = excluded.rooms_sold,
        room_revenue = excluded.room_revenue, total_revenue = excluded.total_revenue, source_report_id = excluded.source_report_id;
    end loop;
    if jsonb_typeof(p_extra->'segments') = 'array' then
      insert into daily_segments(hotel_id, business_date, segment, rooms, revenue, rooms_mtd, revenue_mtd, rooms_ly_mtd, revenue_ly_mtd, rooms_ytd, revenue_ytd, rooms_ly_ytd, revenue_ly_ytd, source_report_id)
      select r.hotel_id, r.business_date, s->>'segment', (s->>'rooms')::numeric, (s->>'revenue')::numeric, (s->>'rooms_mtd')::numeric, (s->>'revenue_mtd')::numeric,
             (s->>'rooms_ly_mtd')::numeric, (s->>'revenue_ly_mtd')::numeric, (s->>'rooms_ytd')::numeric, (s->>'revenue_ytd')::numeric,
             (s->>'rooms_ly_ytd')::numeric, (s->>'revenue_ly_ytd')::numeric, r.id
      from jsonb_array_elements(p_extra->'segments') s
      on conflict (hotel_id, business_date, segment) do update set rooms = excluded.rooms, revenue = excluded.revenue, rooms_mtd = excluded.rooms_mtd,
        revenue_mtd = excluded.revenue_mtd, rooms_ly_mtd = excluded.rooms_ly_mtd, revenue_ly_mtd = excluded.revenue_ly_mtd, rooms_ytd = excluded.rooms_ytd,
        revenue_ytd = excluded.revenue_ytd, rooms_ly_ytd = excluded.rooms_ly_ytd, revenue_ly_ytd = excluded.revenue_ly_ytd, source_report_id = excluded.source_report_id;
    end if;
  end if;
  begin
    perform public._post_daily_revenue(r.hotel_id, r.business_date);
  exception when others then
    update reports set extracted_notes = coalesce(extracted_notes, '{}') || ('Revenue entry not posted: ' || sqlerrm) where id = r.id;
  end;
end $$;

-- ---------------------------------------------------------------- report balances (row security applies: invoker)
create or replace function public.gl_balances(p_from date, p_to date, p_hotels uuid[] default null)
returns table(hotel_id uuid, account_id uuid, opening numeric, debit numeric, credit numeric) language sql stable set search_path = public as $$
  select jl.hotel_id, jl.account_id,
         coalesce(sum(jl.debit - jl.credit) filter (where je.entry_date < p_from), 0),
         coalesce(sum(jl.debit) filter (where je.entry_date between p_from and p_to), 0),
         coalesce(sum(jl.credit) filter (where je.entry_date between p_from and p_to), 0)
  from journal_lines jl join journal_entries je on je.id = jl.entry_id
  where je.entry_date <= p_to and (p_hotels is null or jl.hotel_id = any(p_hotels))
  group by 1, 2
$$;

-- receipts attached to bank transactions can be opened by the hotel's finance team
alter policy vault_read on storage.objects using (
  bucket_id = 'vault' and ((storage.foldername(name))[1])::uuid in (select public.my_tenant_ids())
  and (owner = (select auth.uid())
       or exists (select 1 from public.documents d where d.file_path = objects.name)
       or exists (select 1 from public.bills b where b.file_path = objects.name)
       or exists (select 1 from public.platform_invoices p where p.file_path = objects.name)
       or exists (select 1 from public.bank_transactions t where t.attachment_path = objects.name)));

revoke execute on function public.post_bank_transactions(uuid[]), public.categorize_bank_transactions(uuid[], text, uuid, uuid, text, boolean),
  public.exclude_bank_transactions(uuid[], boolean), public.undo_bank_transactions(uuid[]), public.apply_bank_rules(uuid),
  public.write_check(uuid, date, uuid, text, text, text, jsonb, int), public.pay_bills_by_check(uuid[], uuid, date), public.mark_checks_printed(uuid[], int),
  public.requeue_checks(uuid[]), public.void_check(uuid, text), public.gl_balances(date, date, uuid[]), public.match_transaction(uuid, text, uuid[], uuid) from public, anon;
grant execute on function public.post_bank_transactions(uuid[]), public.categorize_bank_transactions(uuid[], text, uuid, uuid, text, boolean),
  public.exclude_bank_transactions(uuid[], boolean), public.undo_bank_transactions(uuid[]), public.apply_bank_rules(uuid),
  public.write_check(uuid, date, uuid, text, text, text, jsonb, int), public.pay_bills_by_check(uuid[], uuid, date), public.mark_checks_printed(uuid[], int),
  public.requeue_checks(uuid[]), public.void_check(uuid, text), public.gl_balances(date, date, uuid[]), public.match_transaction(uuid, text, uuid[], uuid) to authenticated;
revoke execute on function public.auto_reconcile(uuid) from public, anon;
grant execute on function public.auto_reconcile(uuid) to authenticated;

notify pgrst, 'reload schema';
