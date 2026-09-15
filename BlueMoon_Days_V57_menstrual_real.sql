-- BlueMoon Days V56: บันทึกรอบประจำเดือนจริง
-- ใช้ is_couple_member(uuid) ที่มีอยู่แล้วในฐานข้อมูลเดิมของ BlueMoon Days

create table if not exists public.menstrual_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  couple_id uuid not null references public.couples(id) on delete cascade,
  start_date date not null,
  end_date date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menstrual_periods_dates_check check (end_date is null or end_date >= start_date),
  unique (couple_id, user_id, start_date)
);

create index if not exists menstrual_periods_couple_user_date_idx
on public.menstrual_periods(couple_id, user_id, start_date desc);

alter table public.menstrual_periods enable row level security;

grant select, insert, update, delete
on table public.menstrual_periods
to authenticated;

drop policy if exists "menstrual periods select couple" on public.menstrual_periods;
drop policy if exists "menstrual periods insert own" on public.menstrual_periods;
drop policy if exists "menstrual periods update own" on public.menstrual_periods;
drop policy if exists "menstrual periods delete own" on public.menstrual_periods;

create policy "menstrual periods select couple"
on public.menstrual_periods
for select
to authenticated
using (
  public.is_couple_member(couple_id)
);

create policy "menstrual periods insert own"
on public.menstrual_periods
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_couple_member(couple_id)
);

create policy "menstrual periods update own"
on public.menstrual_periods
for update
to authenticated
using (
  user_id = auth.uid()
  and public.is_couple_member(couple_id)
)
with check (
  user_id = auth.uid()
  and public.is_couple_member(couple_id)
);

create policy "menstrual periods delete own"
on public.menstrual_periods
for delete
to authenticated
using (
  user_id = auth.uid()
);

create or replace function public.touch_menstrual_periods_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists menstrual_periods_updated_at on public.menstrual_periods;
create trigger menstrual_periods_updated_at
before update on public.menstrual_periods
for each row execute function public.touch_menstrual_periods_updated_at();

-- สิทธิ์ service_role เผื่อการจัดการ/สำรองข้อมูลฝั่ง backend

grant select, insert, update, delete
on table public.menstrual_periods
to service_role;
