-- Weight Mates schema. Applied to Supabase project etvfihjbzxhzkfdytgog via MCP
-- migrations; this file is the reference copy.
--
-- Privacy model: raw weights live in owner-only tables. Groups see derived
-- stats (percentage change, streaks) only through SECURITY DEFINER RPCs,
-- which return absolute kg solely for members who opted in (share_weight).

-- ============================================================
-- Tables
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New member'
    check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Personal goal + starting weight. Never exposed to groups.
create table public.tracker (
  user_id uuid primary key references auth.users(id) on delete cascade,
  goal_kg numeric(5,1) check (goal_kg > 0 and goal_kg < 500),
  start_w numeric(5,1) check (start_w > 0 and start_w < 500),
  -- Before/after photo metadata (date + weight at capture); images live in
  -- the private storage bucket.
  photo_meta jsonb,
  updated_at timestamptz not null default now()
);
alter table public.tracker enable row level security;

-- One weigh-in per user per local calendar date.
create table public.entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  d date not null,
  w numeric(5,1) not null check (w > 0 and w < 500),
  updated_at timestamptz not null default now(),
  primary key (user_id, d)
);
alter table public.entries enable row level security;

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  ends_on date,
  invite_code text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.groups enable row level security;

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  share_weight boolean not null default false,
  -- Weight when the member joined; leaderboard % is measured from this.
  -- Set at join time from the latest entry, backfilled from the first
  -- entry after joining when the member had no data yet.
  baseline_w numeric(5,1),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.group_members enable row level security;

create index group_members_user_idx on public.group_members (user_id);
create index entries_user_d_idx on public.entries (user_id, d desc);

-- ============================================================
-- Helper functions
-- ============================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger entries_touch before update on public.entries
  for each row execute function public.set_updated_at();
create trigger tracker_touch before update on public.tracker
  for each row execute function public.set_updated_at();

-- Profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'), ''),
             split_part(coalesce(new.email, 'New member'), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Membership checks used by RLS policies (SECURITY DEFINER avoids
-- recursive policy evaluation on group_members).
create or replace function public.is_group_member(gid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from group_members where group_id = gid and user_id = uid
  );
$$;

create or replace function public.is_co_member(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from group_members a
    join group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- Unambiguous 6-char invite code (no I/L/O/0/1).
create or replace function public.gen_invite_code()
returns text language sql volatile set search_path = public as $$
  select string_agg(
    substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (floor(random() * 31) + 1)::int, 1),
    ''
  ) from generate_series(1, 6);
$$;

-- Consecutive-day run ending exactly at anchor. Dates fall strictly behind
-- row numbers after any gap, so the equality can never re-align.
create or replace function public.streak_at(uid uuid, anchor date)
returns integer language sql stable set search_path = public as $$
  select count(*)::int from (
    select d, (row_number() over (order by d desc) - 1)::int as rn
    from entries where user_id = uid and d <= anchor
  ) t where t.d = anchor - t.rn;
$$;

-- Current streak: anchored to today, or yesterday if today isn't logged yet.
create or replace function public.calc_streak(uid uuid, today date)
returns integer language sql stable set search_path = public as $$
  select case
    when exists (select 1 from entries where user_id = uid and d = today)
      then public.streak_at(uid, today)
    when exists (select 1 from entries where user_id = uid and d = today - 1)
      then public.streak_at(uid, today - 1)
    else 0
  end;
$$;

-- ============================================================
-- RPCs (the only path to other members' derived stats)
-- ============================================================

create or replace function public.create_group(group_name text, group_ends_on date default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  g groups;
  base numeric(5,1);
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if group_name is null or btrim(group_name) = '' then
    raise exception 'Group name required';
  end if;
  loop
    begin
      insert into groups (name, ends_on, invite_code, created_by)
      values (btrim(group_name), group_ends_on, public.gen_invite_code(), auth.uid())
      returning * into g;
      exit;
    exception when unique_violation then
      -- rare invite-code collision; try another code
    end;
  end loop;
  select w into base from entries
    where user_id = auth.uid() and d <= current_date + 1
    order by d desc limit 1;
  insert into group_members (group_id, user_id, baseline_w)
  values (g.id, auth.uid(), base);
  return json_build_object(
    'id', g.id, 'name', g.name, 'ends_on', g.ends_on, 'invite_code', g.invite_code);
end $$;

create or replace function public.join_group(code text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare
  g groups;
  base numeric(5,1);
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select * into g from groups where invite_code = upper(btrim(code));
  if not found then
    raise exception 'That invite code is not valid';
  end if;
  if g.ends_on is not null and g.ends_on < current_date - 1 then
    raise exception 'This competition has already ended';
  end if;
  select w into base from entries
    where user_id = auth.uid() and d <= current_date + 1
    order by d desc limit 1;
  insert into group_members (group_id, user_id, baseline_w)
  values (g.id, auth.uid(), base)
  on conflict (group_id, user_id) do nothing;
  return json_build_object(
    'id', g.id, 'name', g.name, 'ends_on', g.ends_on, 'invite_code', g.invite_code);
end $$;

-- p_today lets the client anchor "today" to its own timezone; it is
-- clamped to +/- 1 day of the server date so it can't be abused.
create or replace function public.group_leaderboard(gid uuid, p_today date default null)
returns table (
  user_id uuid,
  display_name text,
  pct_change numeric,
  streak integer,
  last_checkin date,
  share_weight boolean,
  weight_kg numeric,
  baseline_kg numeric,
  is_self boolean
) language plpgsql volatile security definer set search_path = public as $$
declare
  today date;
  g_ends date;
begin
  today := coalesce(p_today, current_date);
  if today > current_date + 1 or today < current_date - 1 then
    today := current_date;
  end if;
  if not public.is_group_member(gid, auth.uid()) then
    raise exception 'Not a member of this group';
  end if;
  select ends_on into g_ends from groups where id = gid;

  -- Backfill baselines for members who joined before their first weigh-in.
  update group_members gm
  set baseline_w = (
    select e.w from entries e
    where e.user_id = gm.user_id and e.d >= gm.joined_at::date
    order by e.d asc limit 1)
  where gm.group_id = gid and gm.baseline_w is null
    and exists (
      select 1 from entries e
      where e.user_id = gm.user_id and e.d >= gm.joined_at::date);

  return query
  select
    gm.user_id,
    p.display_name,
    case when gm.baseline_w is not null and le.w is not null and gm.baseline_w > 0
         then round((le.w - gm.baseline_w) / gm.baseline_w * 100, 2) end,
    public.calc_streak(gm.user_id, today),
    le.d,
    gm.share_weight,
    case when gm.share_weight or gm.user_id = auth.uid() then le.w end,
    case when gm.share_weight or gm.user_id = auth.uid() then gm.baseline_w end,
    (gm.user_id = auth.uid())
  from group_members gm
  join profiles p on p.id = gm.user_id
  left join lateral (
    select e.d, e.w from entries e
    where e.user_id = gm.user_id and e.d <= least(today, coalesce(g_ends, today))
    order by e.d desc limit 1
  ) le on true
  where gm.group_id = gid
  order by 3 asc nulls last, 4 desc;
end $$;

create or replace function public.group_feed(gid uuid, p_today date default null, lim integer default 30)
returns table (
  d date,
  user_id uuid,
  display_name text,
  streak integer
) language plpgsql stable security definer set search_path = public as $$
declare
  g_ends date;
begin
  if not public.is_group_member(gid, auth.uid()) then
    raise exception 'Not a member of this group';
  end if;
  select ends_on into g_ends from groups where id = gid;
  return query
  select e.d, e.user_id, p.display_name, public.streak_at(e.user_id, e.d)
  from entries e
  join group_members gm on gm.user_id = e.user_id and gm.group_id = gid
  join profiles p on p.id = e.user_id
  where e.d >= gm.joined_at::date
    and (g_ends is null or e.d <= g_ends)
  order by e.d desc, p.display_name
  limit greatest(1, least(lim, 100));
end $$;

-- ============================================================
-- RLS policies
-- ============================================================

create policy "profiles: self or co-member reads" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_co_member(id));

create policy "profiles: self updates" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "tracker: owner only" on public.tracker
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "entries: owner only" on public.entries
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "groups: members read" on public.groups
  for select to authenticated
  using (public.is_group_member(id, auth.uid()));

create policy "group_members: co-members read" on public.group_members
  for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

-- share_weight toggle only (column grant below narrows this further)
create policy "group_members: self updates" on public.group_members
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "group_members: leave" on public.group_members
  for delete to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- Grants: no anon access at all; writes to groups tables only via RPCs.
-- ============================================================

revoke all on public.profiles, public.tracker, public.entries,
  public.groups, public.group_members from anon, authenticated;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.tracker to authenticated;
grant select, insert, update, delete on public.entries to authenticated;
grant select on public.groups to authenticated;
grant select, delete on public.group_members to authenticated;
grant update (share_weight) on public.group_members to authenticated;

-- Internal helpers are not callable from the API.
revoke execute on function public.gen_invite_code() from public, anon, authenticated;
revoke execute on function public.streak_at(uuid, date) from public, anon, authenticated;
revoke execute on function public.calc_streak(uuid, date) from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Note: revoking from PUBLIC matters; functions get an implicit PUBLIC
-- execute grant that a plain "revoke ... from anon" leaves in place.
revoke execute on function public.create_group(text, date) from public, anon;
revoke execute on function public.join_group(text) from public, anon;
revoke execute on function public.group_leaderboard(uuid, date) from public, anon;
revoke execute on function public.group_feed(uuid, date, integer) from public, anon;
grant execute on function public.create_group(text, date) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.group_leaderboard(uuid, date) to authenticated;
grant execute on function public.group_feed(uuid, date, integer) to authenticated;

-- Membership helpers: RLS policy evaluation needs these for signed-in users.
revoke execute on function public.is_group_member(uuid, uuid) from public, anon;
revoke execute on function public.is_co_member(uuid) from public, anon;
grant execute on function public.is_group_member(uuid, uuid) to authenticated;
grant execute on function public.is_co_member(uuid) to authenticated;

-- Future functions never get automatic PUBLIC execute.
alter default privileges in schema public revoke execute on functions from public;

-- ============================================================
-- Storage: private photos bucket, owner-only by folder prefix
-- ============================================================

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

create policy "photos: owner select" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "photos: owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "photos: owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "photos: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
