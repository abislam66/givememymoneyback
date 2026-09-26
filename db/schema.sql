-- SecondLook tables. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Uploaded files are never stored; only the user-confirmed numbers and rules results.

create table if not exists public.analyses (
  id                bigint generated always as identity primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title             text not null,
  source            text not null check (source in ('upload','manual')),
  bill              jsonb not null,   -- user-confirmed numbers, never the file
  eob               jsonb not null,
  result            jsonb not null,   -- rules output: flags, math, summary
  amount_due        numeric(12,2) not null,
  likely_owe        numeric(12,2) not null,
  potential_savings numeric(12,2) not null,
  created_at        timestamptz not null default now()
);
create index if not exists analyses_user_created on public.analyses (user_id, created_at desc);

create table if not exists public.disputes (
  id                bigint generated always as identity primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  analysis_id       bigint not null references public.analyses(id) on delete cascade,
  status            text not null check (status in ('draft','sent','follow_up_due','resolved')),
  potential_savings numeric(12,2) not null,
  confirmed_savings numeric(12,2) not null default 0,  -- set only on resolve
  resolved_amount   numeric(12,2),
  data              jsonb not null,   -- letters, history, dates, escalation
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists disputes_user on public.disputes (user_id);

-- Each user can only see and change their own rows.
alter table public.analyses enable row level security;
alter table public.disputes enable row level security;
drop policy if exists "own analyses" on public.analyses;
create policy "own analyses" on public.analyses for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own disputes" on public.disputes;
create policy "own disputes" on public.disputes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Signed-in users need table privileges (RLS above still limits them to their own rows).
grant select, insert, update, delete on public.analyses, public.disputes to authenticated;
