-- Ask AI daily cap per person (default 60 questions a day; change with app_config key 'ai_daily_limit').
create table if not exists public.ai_usage (
  user_id uuid not null, day date not null, questions int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;   -- server only
revoke all on public.ai_usage from anon, authenticated;

create or replace function public.ai_quota_take() returns int
language plpgsql security definer set search_path = public as $$
declare lim int; used int;
begin
  if auth.uid() is null or not exists (select 1 from public.my_tenant_ids()) then raise exception 'Not allowed'; end if;
  select coalesce((select value::int from public.app_config where key = 'ai_daily_limit'), 60) into lim;
  insert into public.ai_usage(user_id, day, questions) values (auth.uid(), current_date, 1)
    on conflict (user_id, day) do update set questions = ai_usage.questions + 1
    returning questions into used;
  if used > lim then raise exception 'You''ve reached today''s limit of % Ask AI questions. It resets at midnight UTC.', lim; end if;
  return lim - used;
end $$;
revoke execute on function public.ai_quota_take() from public, anon;
grant execute on function public.ai_quota_take() to authenticated;
