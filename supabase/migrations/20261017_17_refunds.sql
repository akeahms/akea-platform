-- Refunds need super admin (Principal) authorization.
--   * Guest refunds and deposit/advance refunds: anyone with finance edit rights at the hotel can REQUEST one; only a
--     Principal (signed in with two-step) can APPROVE or REJECT it; an approved refund is then PAID (finance approve
--     rights or the Principal), which posts its journal entry. Nobody can approve their own request unless they are the
--     only Principal (owners may need to act alone).
--   * Voiding a bill that is already approved, scheduled or paid (a vendor payment refund/reversal) needs a Principal and
--     reverses the bill's journal entries.

-- who counts as super admin: a Principal of that company, with two-step sign-in done
create or replace function public.is_principal(p_tenant uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m join roles r on r.id = m.role_id
                 where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant and r.key = 'principal'
                   and (m.expires_at is null or m.expires_at > now()) and public.mfa_ok(true))
$$;
revoke execute on function public.is_principal(uuid) from public, anon;
grant execute on function public.is_principal(uuid) to authenticated;

create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  kind text not null check (kind in ('guest', 'deposit')),
  guest_name text not null,
  reference text,                               -- folio / confirmation / group number
  amount numeric(12,2) not null check (amount > 0 and amount < 1000000),
  method text not null check (method in ('original_card', 'check', 'ach', 'cash')),
  reason text not null,
  debit_account_id uuid references public.gl_accounts(id),   -- what the refund reduces (room revenue, guest ledger…)
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'paid', 'cancelled')),
  requested_by uuid not null default auth.uid(), requested_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz, decision_note text,
  paid_by uuid, paid_at date, paid_ref text, journal_entry_id uuid,
  data_source text not null default 'live'
);
create index if not exists refund_requests_hotel on public.refund_requests(hotel_id, status, requested_at desc);
alter table public.refund_requests enable row level security;
create policy refund_requests_read on public.refund_requests for select to authenticated
  using (tenant_id in (select public.my_tenant_ids()) and public.can_access_hotel(hotel_id) and public.perm_level(tenant_id, 'finance') >= 1);
-- every change goes through the functions below
revoke insert, update, delete on public.refund_requests from authenticated, anon;
create trigger refund_requests_hotel_tenant before insert or update of hotel_id, tenant_id on public.refund_requests for each row execute function public._hotel_tenant_match();
create trigger refund_requests_same_hotel before insert or update on public.refund_requests for each row execute function public._same_hotel('debit_account_id:gl_accounts');

-- request (finance edit at that hotel)
create or replace function public.request_refund(p_hotel uuid, p_kind text, p_guest text, p_reference text, p_amount numeric, p_method text, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid; rid uuid; acct uuid;
begin
  select tenant_id into t from hotels where id = p_hotel;
  if t is null or not public.can_access_hotel(p_hotel) or public.perm_level(t, 'finance') < 2 then raise exception 'Requesting a refund needs finance edit rights at this hotel'; end if;
  if coalesce(btrim(p_guest), '') = '' or coalesce(btrim(p_reason), '') = '' then raise exception 'Enter the guest and the reason for the refund'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the refund amount'; end if;
  acct := case when p_kind = 'deposit' then public._gl_sys(p_hotel, 'guest_ledger') else public._gl_sys(p_hotel, 'room_revenue') end;
  insert into refund_requests(tenant_id, hotel_id, kind, guest_name, reference, amount, method, reason, debit_account_id)
  values (t, p_hotel, p_kind, btrim(p_guest), nullif(btrim(p_reference), ''), round(p_amount, 2), p_method, btrim(p_reason), acct) returning id into rid;
  insert into notifications(tenant_id, hotel_id, module, kind, object_id, title, body, link)
  values (t, p_hotel, 'finance', 'refund_request', rid, 'Refund waiting for approval: ' || to_char(round(p_amount, 2), 'FM$999,999,990.00'),
          btrim(p_guest) || coalesce(' · ' || nullif(btrim(p_reference), ''), '') || ' — ' || left(btrim(p_reason), 200), 'refunds');
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (t, auth.uid(), 'request', 'refund', rid::text, jsonb_build_object('amount', p_amount, 'kind', p_kind, 'guest', p_guest));
  return rid;
end $$;

-- approve / reject: Principal only
create or replace function public.decide_refund(p_id uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r refund_requests; principals int;
begin
  select * into r from refund_requests where id = p_id for update;
  if r.id is null or not public.can_access_hotel(r.hotel_id) then raise exception 'Refund not found'; end if;
  if not public.is_principal(r.tenant_id) then raise exception 'Only a Principal (super admin) can approve refunds, signed in with two-step verification.'; end if;
  if r.status <> 'requested' then raise exception 'This refund is already %', r.status; end if;
  select count(*) into principals from memberships m join roles ro on ro.id = m.role_id where m.tenant_id = r.tenant_id and ro.key = 'principal';
  if p_approve and r.requested_by = auth.uid() and principals > 1 then raise exception 'Another Principal needs to approve a refund you requested.'; end if;
  update refund_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = p_id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (r.tenant_id, auth.uid(), case when p_approve then 'approve' else 'reject' end, 'refund', r.id::text, jsonb_build_object('amount', r.amount, 'note', p_note));
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

-- record the refund as paid (only after a Principal approved it): Dr revenue / guest ledger, Cr card clearing or cash
create or replace function public.pay_refund(p_id uuid, p_date date, p_ref text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r refund_requests; jid uuid; cr uuid;
begin
  select * into r from refund_requests where id = p_id for update;
  if r.id is null or not public.can_access_hotel(r.hotel_id) then raise exception 'Refund not found'; end if;
  if public.perm_level(r.tenant_id, 'finance') < 3 and not public.is_principal(r.tenant_id) then raise exception 'Recording a refund as paid needs finance approval rights'; end if;
  if r.status <> 'approved' then raise exception 'A refund can only be paid after a Principal approves it (it is %)', r.status; end if;
  cr := case when r.method = 'original_card' then public._gl_sys(r.hotel_id, 'card_clearing') else public._gl_sys(r.hotel_id, 'cash') end;
  jid := public.post_journal(r.hotel_id, coalesce(p_date, current_date), 'Refund · ' || r.guest_name || coalesce(' · ' || r.reference, ''),
    jsonb_build_array(jsonb_build_object('account_id', coalesce(r.debit_account_id, public._gl_sys(r.hotel_id, 'room_revenue')), 'debit', r.amount, 'memo', left(r.reason, 200)),
                      jsonb_build_object('account_id', cr, 'credit', r.amount)), 'refund', r.id);
  update refund_requests set status = 'paid', paid_by = auth.uid(), paid_at = coalesce(p_date, current_date), paid_ref = nullif(btrim(p_ref), ''), journal_entry_id = jid where id = p_id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (r.tenant_id, auth.uid(), 'pay', 'refund', r.id::text, jsonb_build_object('amount', r.amount, 'journal', jid));
  return jid;
end $$;

-- the requester (or a Principal) can withdraw a request that hasn't been decided
create or replace function public.cancel_refund(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r refund_requests;
begin
  select * into r from refund_requests where id = p_id for update;
  if r.id is null or not public.can_access_hotel(r.hotel_id) then raise exception 'Refund not found'; end if;
  if r.status <> 'requested' then raise exception 'Only a waiting request can be withdrawn'; end if;
  if r.requested_by <> auth.uid() and not public.is_principal(r.tenant_id) then raise exception 'Only the person who asked (or a Principal) can withdraw it'; end if;
  update refund_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now() where id = p_id;
end $$;

-- voiding an approved / scheduled / paid bill: Principal only; reverses every journal entry the bill produced
create or replace function public.void_bill(p_id uuid, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare b bills; e record; n int := 0;
begin
  select * into b from bills where id = p_id for update;
  if b.id is null or not public.can_access_hotel(b.hotel_id) then raise exception 'Bill not found'; end if;
  if b.status not in ('approved', 'scheduled', 'paid') then raise exception 'Only approved, scheduled or paid bills need voiding (this one is %)', b.status; end if;
  if not public.is_principal(b.tenant_id) then raise exception 'Only a Principal (super admin) can void an approved or paid bill.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Enter the reason for voiding'; end if;
  for e in select j.id, j.entry_date from journal_entries j where j.source in ('bill', 'payment') and j.source_id = b.id
           and not exists (select 1 from journal_entries x where x.source = 'void' and x.source_id = j.id) loop
    perform public.post_journal(b.hotel_id, current_date, 'Void of bill ' || coalesce(b.invoice_no, '') || ' — ' || left(btrim(p_reason), 150),
      (select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.credit, 'credit', l.debit)) from journal_lines l where l.entry_id = e.id), 'void', e.id);
    n := n + 1;
  end loop;
  perform set_config('akea.approved_path', 'on', true);
  update bills set status = 'void', decision_note = left(btrim(p_reason), 500) where id = b.id;
  insert into audit_log(tenant_id, user_id, action, object_type, object_id, detail)
    values (b.tenant_id, auth.uid(), 'void', 'bill', b.id::text, jsonb_build_object('amount', b.amount, 'was', b.status, 'reason', p_reason, 'reversed_entries', n));
  return n;
end $$;

-- an approved / scheduled / paid bill can't be voided or rejected any other way
create or replace function public._guard_bill_money() returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('akea.approved_path', true), '') = 'on' then return new; end if;
  if old.status in ('approved', 'scheduled', 'paid') then
    if new.amount is distinct from old.amount or new.gl_account_id is distinct from old.gl_account_id or new.vendor_id is distinct from old.vendor_id
       or new.hotel_id is distinct from old.hotel_id or new.invoice_date is distinct from old.invoice_date or new.bank_account_id is distinct from old.bank_account_id then
      raise exception 'This bill is already approved, so its amount, account, vendor and dates are locked. A Principal can void it.';
    end if;
    if new.status in ('draft', 'pending_approval') then raise exception 'An approved bill can''t go back to draft. A Principal can void it.'; end if;
    if new.status in ('void', 'rejected') then raise exception 'Voiding an approved or paid bill needs a Principal (Void bill).'; end if;
  end if;
  return new;
end $$;

revoke execute on function public.request_refund(uuid, text, text, text, numeric, text, text), public.decide_refund(uuid, boolean, text),
  public.pay_refund(uuid, date, text), public.cancel_refund(uuid), public.void_bill(uuid, text) from public, anon;
grant execute on function public.request_refund(uuid, text, text, text, numeric, text, text), public.decide_refund(uuid, boolean, text),
  public.pay_refund(uuid, date, text), public.cancel_refund(uuid), public.void_bill(uuid, text) to authenticated;
