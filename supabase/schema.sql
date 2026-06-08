-- Smoke-checks Supabase-schema.
-- Draai dit één keer in de SQL Editor van je Supabase-project.

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trigger text,
  commit_sha text,
  total int default 0,
  passed int default 0,
  failed int default 0
);

create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.runs(id) on delete cascade,
  created_at timestamptz not null default now(),
  site_slug text not null,
  name text,
  path text,
  status text check (status in ('pass', 'fail')),
  http_status int,
  messages jsonb default '[]'::jsonb,
  duration_ms int,
  screenshot_key text
);

create index if not exists checks_run_id_idx on public.checks (run_id);
create index if not exists runs_created_at_idx on public.runs (created_at desc);

-- RLS: ingelogde gebruikers mogen lezen. Schrijven gebeurt vanuit GitHub Actions
-- met de service-role-key, die RLS omzeilt — dus geen insert-policy nodig.
alter table public.runs enable row level security;
alter table public.checks enable row level security;

drop policy if exists "auth read runs" on public.runs;
create policy "auth read runs" on public.runs
  for select to authenticated using (true);

drop policy if exists "auth read checks" on public.checks;
create policy "auth read checks" on public.checks
  for select to authenticated using (true);

-- Privé Storage-bucket voor screenshots.
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;

drop policy if exists "auth read screenshots" on storage.objects;
create policy "auth read screenshots" on storage.objects
  for select to authenticated using (bucket_id = 'screenshots');
