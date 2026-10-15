-- Security advisor fixes
alter function public._std_rls(text, text, text, int, boolean) set search_path = public;
alter function public._guard_money_status() set search_path = public;
revoke execute on function public._approval_limit(uuid) from authenticated;
