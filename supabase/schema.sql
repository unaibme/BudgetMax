-- PKR Budget Tracker no-login Supabase schema
-- Run this in Supabase Dashboard > SQL Editor.
-- Safe to run again. It migrates the older login-based schema to Budget Space code syncing.

create extension if not exists pgcrypto;

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  budget_id text not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric(12, 2) not null check (amount > 0),
  category text not null,
  note text,
  tx_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migration support for older versions that used auth.users/user_id.
alter table public.transactions add column if not exists budget_id text;
update public.transactions
set budget_id = coalesce(budget_id, 'PKR-LEGACY')
where budget_id is null;
alter table public.transactions alter column budget_id set not null;
alter table public.transactions alter column budget_id set default 'PKR-PERSONAL';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'user_id'
  ) then
    execute 'alter table public.transactions alter column user_id drop not null';
  end if;
end $$;

create table if not exists public.budget_settings (
  budget_id text primary key,
  monthly_budget numeric(12, 2) not null default 50000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions enable row level security;
alter table public.budget_settings enable row level security;

-- Remove old login-only policies from the earlier app version.
drop policy if exists "Users can read their own transactions" on public.transactions;
drop policy if exists "Users can insert their own transactions" on public.transactions;
drop policy if exists "Users can update their own transactions" on public.transactions;
drop policy if exists "Users can delete their own transactions" on public.transactions;

-- No-login mode: the anon/publishable key can read/write rows.
-- Data is separated in the app by budget_id. Share the same Budget Space code across your own devices.
drop policy if exists "Anyone can read transactions by budget space" on public.transactions;
create policy "Anyone can read transactions by budget space"
on public.transactions for select
to anon, authenticated
using (true);

drop policy if exists "Anyone can insert transactions by budget space" on public.transactions;
create policy "Anyone can insert transactions by budget space"
on public.transactions for insert
to anon, authenticated
with check (budget_id is not null and char_length(budget_id) between 3 and 24);

drop policy if exists "Anyone can update transactions by budget space" on public.transactions;
create policy "Anyone can update transactions by budget space"
on public.transactions for update
to anon, authenticated
using (true)
with check (budget_id is not null and char_length(budget_id) between 3 and 24);

drop policy if exists "Anyone can delete transactions by budget space" on public.transactions;
create policy "Anyone can delete transactions by budget space"
on public.transactions for delete
to anon, authenticated
using (true);

drop policy if exists "Anyone can read budget settings" on public.budget_settings;
create policy "Anyone can read budget settings"
on public.budget_settings for select
to anon, authenticated
using (true);

drop policy if exists "Anyone can insert budget settings" on public.budget_settings;
create policy "Anyone can insert budget settings"
on public.budget_settings for insert
to anon, authenticated
with check (budget_id is not null and char_length(budget_id) between 3 and 24);

drop policy if exists "Anyone can update budget settings" on public.budget_settings;
create policy "Anyone can update budget settings"
on public.budget_settings for update
to anon, authenticated
using (true)
with check (budget_id is not null and char_length(budget_id) between 3 and 24);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.transactions to anon, authenticated;
grant select, insert, update, delete on public.budget_settings to anon, authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_transactions_updated_at on public.transactions;
create trigger set_transactions_updated_at
before update on public.transactions
for each row execute function public.set_updated_at();

drop trigger if exists set_budget_settings_updated_at on public.budget_settings;
create trigger set_budget_settings_updated_at
before update on public.budget_settings
for each row execute function public.set_updated_at();

create index if not exists transactions_budget_date_idx
on public.transactions (budget_id, tx_date desc, created_at desc);

create index if not exists transactions_budget_type_date_idx
on public.transactions (budget_id, type, tx_date desc);

-- Add device_id and sync_status for multi-device sync resolution.
-- device_id  – traces which device last modified a row
-- sync_status – 'synced' | 'pending'; pending rows came from a device that was offline
-- Both columns are nullable so existing rows are unaffected until migrated.
alter table if exists public.transactions add column if not exists device_id text;
alter table if exists public.transactions add column if not exists sync_status text check (sync_status in ('synced','pending'));

-- New rows default to synced (the app will write 'pending' explicitly for offline inserts).
-- Migrate existing rows that have no device_id / sync_status yet.
update public.transactions set device_id = coalesce(device_id, 'PKR-LEGACY'), sync_status = coalesce(sync_status, 'synced') where device_id is null or sync_status is null;

-- ── Data-integrity helper: merge dedups ─────────────────────────────────────
-- trans_insertedOnLoad  – tracks the timestamp of the last server load per
--                         device+space so the sync routine can compare against
--                         updated_at and decide whether any records newer than the
--                         cache exist on the server.  We store this in localStorage,
--                         not in the database (client-only flag, no schema needed).

create index if not exists transactions_device_updated_idx
  on public.transactions (device_id, updated_at desc);

-- ── Enable realtime sync for supported Supabase projects. ───────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'transactions'
    ) then
      alter publication supabase_realtime add table public.transactions;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'budget_settings'
    ) then
      alter publication supabase_realtime add table public.budget_settings;
    end if;
  end if;
end $$;

-- ── Service-level helper: last-server-wins on updated_at ─────────────────────
-- Expose a callable function so the sync routine or service role can force-clear
-- stale rows on duplicate content without needing a unique constraint.
create or replace function public.resolve_transaction_conflict(
  p_space   text,
  p_type    text,
  p_amount  numeric,
  p_date    date,
  p_note    text default null,
  p_updated timestamptz default now()
)
returns void
language plpgsql
as $$
begin
  -- Delete an older duplicate row that has the same space+type+amount+date+note
  -- and was written earlier than p_updated.
  delete from public.transactions t
  using (
    select id
    from public.transactions
    where budget_id   = p_space
      and type        = p_type
      and amount      = p_amount
      and tx_date     = p_date
      and coalesce(note,'') = coalesce(p_note,'')
      and updated_at  < p_updated
    order by updated_at asc
    limit 1
  ) stale
  where t.id = stale.id;
end;
$$;
