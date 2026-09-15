-- BlueMoon Days V52: shared menstrual-cycle predictions
create table if not exists public.menstrual_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  couple_id uuid not null references public.couples(id) on delete cascade,
  last_period_start date not null,
  cycle_length integer not null default 28 check (cycle_length between 21 and 45),
  period_length integer not null default 5 check (period_length between 2 and 10),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists menstrual_cycles_couple_id_idx
  on public.menstrual_cycles(couple_id);

alter table public.menstrual_cycles enable row level security;

drop policy if exists "menstrual cycles select couple" on public.menstrual_cycles;
create policy "menstrual cycles select couple"
on public.menstrual_cycles
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.couple_members me
    join public.couple_members partner on partner.couple_id = me.couple_id
    where me.user_id = auth.uid()
      and partner.user_id = public.menstrual_cycles.user_id
      and me.couple_id = public.menstrual_cycles.couple_id
  )
);

drop policy if exists "menstrual cycles insert own" on public.menstrual_cycles;
create policy "menstrual cycles insert own"
on public.menstrual_cycles
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.couple_members
    where user_id = auth.uid()
      and couple_id = public.menstrual_cycles.couple_id
  )
);

drop policy if exists "menstrual cycles update own" on public.menstrual_cycles;
create policy "menstrual cycles update own"
on public.menstrual_cycles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Allow the app's service-role push/cron infrastructure to read the table if needed.
grant select, insert, update, delete
on table public.menstrual_cycles
to service_role;
