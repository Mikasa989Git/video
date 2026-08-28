-- video-engine — Supabase schema.
--
-- Run this once in the Supabase project's SQL Editor (or via `supabase db push` if using
-- the CLI) before starting the server with SUPABASE_* env vars set. Tier definitions
-- themselves live in config/pricing-tiers.json (edit that, then re-run the seed block at
-- the bottom, or call POST /api/admin/reseed-tiers once that route exists) rather than
-- being hardcoded here, so pricing/limits can change without a migration.

-- Mirrors auth.users 1:1, populated by the trigger below on signup.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, email) values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

create table if not exists subscription_tiers (
  id text primary key, -- matches config/pricing-tiers.json's "id" field, e.g. 'starter'
  name text not null,
  price_ils_monthly numeric not null,
  included_videos_per_month int not null,
  max_video_length_minutes int not null,
  features jsonb not null default '[]'
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  tier_id text not null references subscription_tiers(id),
  status text not null check (status in ('active', 'canceled', 'past_due')),
  payplus_recurring_uid text,
  payplus_card_token text,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null,
  videos_used_current_period int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists subscriptions_user_id_idx on subscriptions(user_id);

create table if not exists video_jobs (
  id text primary key, -- same jobId used for the output/<jobId> directory
  user_id uuid not null references profiles(id) on delete cascade,
  topic text not null,
  length_minutes int not null,
  status text not null default 'running',
  job_dir text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists video_jobs_user_id_idx on video_jobs(user_id);

-- Raw webhook payloads for audit + idempotency (don't double-process the same PayPlus event).
create table if not exists payplus_events (
  id uuid primary key default gen_random_uuid(),
  event_uid text unique, -- PayPlus's own transaction/recurring uid, used to dedupe
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table subscription_tiers enable row level security;
alter table subscriptions enable row level security;
alter table video_jobs enable row level security;
alter table payplus_events enable row level security;

-- The Node server talks to Supabase using the service role key (bypasses RLS) for all
-- trusted server-side operations — these policies only matter if the browser ever reads
-- directly with the anon key + user JWT (e.g. tier list on the pricing page).
create policy "tiers are publicly readable" on subscription_tiers
  for select using (true);

create policy "users can read their own profile" on profiles
  for select using (auth.uid() = id);

create policy "users can read their own subscriptions" on subscriptions
  for select using (auth.uid() = user_id);

create policy "users can read their own jobs" on video_jobs
  for select using (auth.uid() = user_id);

-- Seed subscription_tiers from config/pricing-tiers.json's current placeholder values.
-- Re-run this block (with updated values) any time that file changes, until an admin
-- route automates it.
insert into subscription_tiers (id, name, price_ils_monthly, included_videos_per_month, max_video_length_minutes, features) values
  ('starter', 'Starter', 99, 2, 10, '["2 videos per month", "Up to 10 minutes each", "Standard support"]'),
  ('creator', 'Creator', 249, 6, 15, '["6 videos per month", "Up to 15 minutes each", "Priority support"]'),
  ('studio', 'Studio', 599, 20, 15, '["20 videos per month", "Up to 15 minutes each", "Priority support", "Early access to new styles"]')
on conflict (id) do update set
  name = excluded.name,
  price_ils_monthly = excluded.price_ils_monthly,
  included_videos_per_month = excluded.included_videos_per_month,
  max_video_length_minutes = excluded.max_video_length_minutes,
  features = excluded.features;
