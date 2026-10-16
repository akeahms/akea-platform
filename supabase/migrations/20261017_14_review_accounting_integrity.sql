-- Review fixes: accounting integrity.
-- 1) journals are written only by post_journal (which checks access and balance); no direct table writes from the API
revoke insert, update, delete, truncate on public.journal_entries, public.journal_lines from authenticated, anon;

-- 2) the database itself refuses an unbalanced entry (checked at commit, so multi-line inserts work)
create or replace function public._journal_balanced() returns trigger language plpgsql set search_path = public as $$
declare e uuid := coalesce(new.entry_id, old.entry_id); dr numeric; cr numeric;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into dr, cr from journal_lines where entry_id = e;
  if round(dr, 2) <> round(cr, 2) then raise exception 'Journal entry % does not balance (debits %, credits %)', e, dr, cr; end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert or update on public.journal_lines
  deferrable initially deferred for each row execute function public._journal_balanced();

-- 3) once a bill is approved its money fields are locked, and it can't be sent back to draft
create or replace function public._guard_bill_money() returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('akea.approved_path', true), '') = 'on' then return new; end if;
  if old.status in ('approved', 'scheduled', 'paid') then
    if new.amount is distinct from old.amount or new.gl_account_id is distinct from old.gl_account_id or new.vendor_id is distinct from old.vendor_id
       or new.hotel_id is distinct from old.hotel_id or new.invoice_date is distinct from old.invoice_date or new.bank_account_id is distinct from old.bank_account_id then
      raise exception 'This bill is already approved, so its amount, account, vendor and dates are locked. Reject or void it and enter a new bill instead.';
    end if;
    if new.status in ('draft', 'pending_approval') then raise exception 'An approved bill can''t go back to draft. Void it and enter a new bill instead.'; end if;
  end if;
  return new;
end $$;
create trigger bills_money_lock before update on public.bills for each row execute function public._guard_bill_money();

-- 4) a bill that auto-matches a cleared bank payment gets its payment journal (Dr Accounts Payable, Cr bank) like Pay does
do $$
declare def text;
begin
  def := pg_get_functiondef('public.auto_reconcile(uuid)'::regprocedure);
  def := replace(def, 'select bl.id, bl.status into b from bills bl', 'select bl.id, bl.status, bl.amount, bl.invoice_no into b from bills bl');
  def := replace(def, 'update bills set status = ''paid'', paid_at = tx.posted_date where id = b.id;',
    'update bills set status = ''paid'', paid_at = tx.posted_date, bank_account_id = coalesce(bank_account_id, ba.id) where id = b.id;
        if not exists (select 1 from journal_entries j where j.source = ''payment'' and j.source_id = b.id) then
          perform public.post_journal(ba.hotel_id, tx.posted_date, ''Payment '' || coalesce(b.invoice_no, '''') || '' (cleared the bank)'',
            jsonb_build_array(jsonb_build_object(''account_id'', public._gl_sys(ba.hotel_id, ''ap''), ''debit'', b.amount),
                              jsonb_build_object(''account_id'', coalesce(ba.gl_account_id, public._gl_sys(ba.hotel_id, ''cash'')), ''credit'', b.amount)), ''payment'', b.id);
        end if;');
  if position('cleared the bank' in def) = 0 then raise exception 'auto_reconcile did not match the expected text'; end if;
  execute def;
end $$;

-- 5) every hotel-scoped row belongs to the same company as its hotel (a trigger, not a second foreign key:
--    two foreign keys between the same tables make the API's embedded lookups ambiguous)
create or replace function public._hotel_tenant_match() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.hotel_id is not null and new.tenant_id is distinct from (select h.tenant_id from hotels h where h.id = new.hotel_id) then
    raise exception 'This record''s company doesn''t match its hotel''s company.';
  end if;
  return new;
end $$;
revoke execute on function public._hotel_tenant_match() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['bank_accounts','bank_transactions','bills','budget_gl','change_orders','construction_budget','construction_draws','construction_milestones',
    'departments','distributions','documents','employee_pay','employees','expected_deposits','gl_accounts','inbound_emails','insurance_policies','investor_holdings',
    'journal_entries','journal_lines','notifications','permits','po_lines','purchase_orders','qbo_account_map','qbo_accounts','qbo_connections','qbo_settings',
    'qbo_sync_log','reports','shift_requests','shifts','snapshot_recipients','snapshot_sends','statement_imports','time_punches'] loop
    execute format('create trigger %I before insert or update of hotel_id, tenant_id on public.%I for each row execute function public._hotel_tenant_match()', t || '_hotel_tenant', t);
  end loop;
end $$;
