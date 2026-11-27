-- ZEUS Watch Party. Requires Supabase Auth anonymous sign-ins and Realtime.
-- The public browser key is NOT a credential with elevated database access.
-- All mutations and snapshots go through the checked functions below; the
-- underlying tables have RLS enabled and no client table privileges.

create table public.zeus_party_rooms (
  code text primary key check (code ~ '^[0-9A-F]{20}$'),
  host_id uuid not null,
  provider text not null check (provider in ('vidspark', 'cinesrc')),
  media_type text not null check (media_type in ('movie', 'tv')),
  tmdb_id text not null check (tmdb_id ~ '^[0-9]{1,12}$'),
  season integer not null check (season between 1 and 999),
  episode integer not null check (episode between 1 and 9999),
  title text not null check (char_length(title) between 1 and 200),
  playing boolean not null default false,
  position_seconds double precision not null default 0 check (position_seconds between 0 and 86400),
  state_updated_at timestamptz not null default clock_timestamp(),
  revision bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '12 hours'),
  ended_at timestamptz
);

create table public.zeus_party_members (
  room_code text not null references public.zeus_party_rooms(code) on delete cascade,
  user_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 32),
  joined_at timestamptz not null default clock_timestamp(),
  last_seen timestamptz not null default clock_timestamp(),
  last_chat_at timestamptz,
  primary key (room_code, user_id)
);

create table public.zeus_party_messages (
  id bigint generated always as identity primary key,
  room_code text not null references public.zeus_party_rooms(code) on delete cascade,
  user_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 32),
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create index zeus_party_messages_room_id_idx on public.zeus_party_messages (room_code, id desc);
create index zeus_party_rooms_expiry_idx on public.zeus_party_rooms (expires_at);

alter table public.zeus_party_rooms enable row level security;
alter table public.zeus_party_members enable row level security;
alter table public.zeus_party_messages enable row level security;
revoke all on public.zeus_party_rooms, public.zeus_party_members, public.zeus_party_messages from public, anon, authenticated;
revoke all on sequence public.zeus_party_messages_id_seq from public, anon, authenticated;

-- This helper is also used by Realtime's private channel RLS. A random room
-- code is an invite, not host authority; the current authenticated user must
-- already have joined that exact room to listen.
create function public.zeus_party_can_listen(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.zeus_party_members m
    where m.user_id = auth.uid() and p_topic = 'zeus-party:' || m.room_code
  );
$$;
revoke all on function public.zeus_party_can_listen(text) from public, anon;
grant execute on function public.zeus_party_can_listen(text) to authenticated;

create policy zeus_party_private_broadcast_read on realtime.messages
  for select to authenticated
  using (extension = 'broadcast' and public.zeus_party_can_listen((select realtime.topic())));
-- Clients cannot write to this channel. The server emits data-free wakeups;
-- clients fetch and authorize the authoritative state through the RPC below.
create function public.zeus_party_notify(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send('{}'::jsonb, 'changed', 'zeus-party:' || p_code, true);
  exception when others then
    -- A temporarily unavailable Realtime service must not lose the state.
    -- Clients also poll and report their degraded connection state.
    null;
  end;
end;
$$;
revoke all on function public.zeus_party_notify(text) from public, anon, authenticated;

create function public.zeus_party_snapshot(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.zeus_party_rooms%rowtype;
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  if v_user is null then raise exception 'Sign in to join a party' using errcode = '42501'; end if;
  select * into r from public.zeus_party_rooms where code = v_code;
  if not found or not exists (
    select 1 from public.zeus_party_members m where m.room_code = v_code and m.user_id = v_user
  ) then
    raise exception 'Party not found or access denied' using errcode = '42501';
  end if;
  -- If the host disappears, freeze rather than extrapolating indefinitely.
  -- The host's next successful player update resumes authority after rejoining.
  if r.playing and not exists (
    select 1 from public.zeus_party_members m where m.room_code = v_code and m.user_id = r.host_id
      and m.last_seen > clock_timestamp() - interval '55 seconds'
  ) then
    update public.zeus_party_rooms room set
      position_seconds = least(86400, room.position_seconds + greatest(0, extract(epoch from (
        least(clock_timestamp(), coalesce((select m.last_seen + interval '55 seconds'
          from public.zeus_party_members m where m.room_code = v_code and m.user_id = room.host_id), room.state_updated_at))
        - room.state_updated_at)))),
      playing = false, state_updated_at = clock_timestamp(), revision = room.revision + 1
    where room.code = v_code and room.playing and not exists (
      select 1 from public.zeus_party_members m where m.room_code = v_code and m.user_id = room.host_id
        and m.last_seen > clock_timestamp() - interval '55 seconds'
    ) returning * into r;
    if found then perform public.zeus_party_notify(v_code);
    else select * into r from public.zeus_party_rooms where code = v_code; end if;
  end if;
  return jsonb_build_object(
    'you', v_user,
    'server_now', clock_timestamp(),
    'room', jsonb_build_object(
      'code', r.code, 'host_id', r.host_id, 'provider', r.provider,
      'media_type', r.media_type, 'tmdb_id', r.tmdb_id, 'season', r.season,
      'episode', r.episode, 'title', r.title, 'playing', r.playing,
      'position_seconds', r.position_seconds, 'state_updated_at', r.state_updated_at,
      'revision', r.revision, 'ended', (r.ended_at is not null or r.expires_at <= clock_timestamp()),
      'expires_at', r.expires_at
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.user_id, 'name', m.display_name,
        'host', m.user_id = r.host_id,
        'online', m.last_seen > clock_timestamp() - interval '55 seconds'
      ) order by (m.user_id = r.host_id) desc, m.joined_at)
      from public.zeus_party_members m where m.room_code = v_code
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recent.id, 'name', recent.display_name, 'body', recent.body,
        'user_id', recent.user_id, 'created_at', recent.created_at
      ) order by recent.id)
      from (select * from public.zeus_party_messages where room_code = v_code order by id desc limit 50) recent
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.zeus_party_snapshot(text) from public, anon;
grant execute on function public.zeus_party_snapshot(text) to authenticated;

create function public.zeus_party_create(
  p_name text, p_provider text, p_media_type text, p_tmdb_id text,
  p_season integer, p_episode integer, p_title text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 32);
  v_title text := left(trim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]', '', 'g')), 200);
begin
  if v_user is null then raise exception 'Sign in to create a party' using errcode = '42501'; end if;
  if v_name = '' or v_title = '' or p_provider is null or p_provider not in ('vidspark', 'cinesrc')
    or p_media_type is null or p_media_type not in ('movie', 'tv')
    or p_tmdb_id is null or p_tmdb_id !~ '^[0-9]{1,12}$'
    or p_season is null or p_season not between 1 and 999
    or p_episode is null or p_episode not between 1 and 9999 then
    raise exception 'Invalid party details' using errcode = '22023';
  end if;
  -- Lazy retention cleanup; an operator can also schedule the documented cleanup.
  delete from public.zeus_party_rooms where expires_at < clock_timestamp() - interval '12 hours';
  if (select count(*) from public.zeus_party_rooms
      where host_id = v_user and ended_at is null and expires_at > clock_timestamp()) >= 3 then
    raise exception 'End an existing party before creating another';
  end if;
  loop
    v_code := upper(encode(extensions.gen_random_bytes(10), 'hex'));
    begin
      insert into public.zeus_party_rooms(code, host_id, provider, media_type, tmdb_id, season, episode, title)
      values (v_code, v_user, p_provider, p_media_type, p_tmdb_id, p_season, p_episode, v_title);
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  insert into public.zeus_party_members(room_code, user_id, display_name) values (v_code, v_user, v_name);
  return public.zeus_party_snapshot(v_code);
end;
$$;
revoke all on function public.zeus_party_create(text,text,text,text,integer,integer,text) from public, anon;
grant execute on function public.zeus_party_create(text,text,text,text,integer,integer,text) to authenticated;

create function public.zeus_party_join(p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
  v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 32);
  r public.zeus_party_rooms%rowtype;
begin
  if v_user is null then raise exception 'Sign in to join a party' using errcode = '42501'; end if;
  if v_code !~ '^[0-9A-F]{20}$' or v_name = '' then raise exception 'Enter a valid code and name' using errcode = '22023'; end if;
  select * into r from public.zeus_party_rooms where code = v_code for update;
  if not found or r.ended_at is not null or r.expires_at <= clock_timestamp() then raise exception 'Party not found or has ended'; end if;
  -- Bound active and stale membership growth. The host may always reconnect.
  delete from public.zeus_party_members where room_code = v_code and user_id <> r.host_id
    and last_seen < clock_timestamp() - interval '3 hours';
  if not exists (select 1 from public.zeus_party_members where room_code = v_code and user_id = v_user)
     and (select count(*) from public.zeus_party_members where room_code = v_code) >= 40 then
    raise exception 'This party is full';
  end if;
  insert into public.zeus_party_members(room_code, user_id, display_name, last_seen)
    values (v_code, v_user, v_name, clock_timestamp())
    on conflict (room_code, user_id) do update set display_name = excluded.display_name, last_seen = excluded.last_seen;
  perform public.zeus_party_notify(v_code);
  return public.zeus_party_snapshot(v_code);
end;
$$;
revoke all on function public.zeus_party_join(text,text) from public, anon;
grant execute on function public.zeus_party_join(text,text) to authenticated;

create function public.zeus_party_heartbeat(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
  v_old timestamptz;
begin
  select last_seen into v_old from public.zeus_party_members where room_code = v_code and user_id = v_user for update;
  if not found or not exists (select 1 from public.zeus_party_rooms where code = v_code and ended_at is null and expires_at > clock_timestamp()) then
    raise exception 'Party ended or access denied' using errcode = '42501';
  end if;
  update public.zeus_party_members set last_seen = clock_timestamp() where room_code = v_code and user_id = v_user;
  if v_old < clock_timestamp() - interval '55 seconds' then perform public.zeus_party_notify(v_code); end if;
end;
$$;
revoke all on function public.zeus_party_heartbeat(text) from public, anon;
grant execute on function public.zeus_party_heartbeat(text) to authenticated;

create function public.zeus_party_playback(p_code text, p_action text, p_time double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  if p_action is null or p_action not in ('play', 'pause', 'seek', 'sync_play', 'sync_pause') or p_time is null or p_time < 0 or p_time > 86400 then
    raise exception 'Invalid playback command' using errcode = '22023';
  end if;
  update public.zeus_party_rooms r set
    playing = case when p_action in ('play', 'sync_play') then true when p_action in ('pause', 'sync_pause') then false else r.playing end,
    position_seconds = p_time, state_updated_at = clock_timestamp(), revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can control playback' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;
revoke all on function public.zeus_party_playback(text,text,double precision) from public, anon;
grant execute on function public.zeus_party_playback(text,text,double precision) to authenticated;

create function public.zeus_party_set_provider(p_code text, p_provider text, p_time double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  if p_provider is null or p_provider not in ('vidspark', 'cinesrc') or p_time is null or p_time < 0 or p_time > 86400 then
    raise exception 'Invalid player selection' using errcode = '22023';
  end if;
  update public.zeus_party_rooms r set provider = p_provider, position_seconds = p_time,
    playing = false, state_updated_at = clock_timestamp(), revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can change players' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;
revoke all on function public.zeus_party_set_provider(text,text,double precision) from public, anon;
grant execute on function public.zeus_party_set_provider(text,text,double precision) to authenticated;

create function public.zeus_party_chat(p_code text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
  v_body text := trim(regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]', ' ', 'g'));
  v_name text;
begin
  if char_length(v_body) < 1 or char_length(v_body) > 500 then raise exception 'Messages must be 1–500 characters' using errcode = '22023'; end if;
  update public.zeus_party_members m set last_chat_at = clock_timestamp(), last_seen = clock_timestamp()
  where m.room_code = v_code and m.user_id = v_user
    and (m.last_chat_at is null or m.last_chat_at < clock_timestamp() - interval '1 second')
    and exists (select 1 from public.zeus_party_rooms r where r.code = v_code and r.ended_at is null and r.expires_at > clock_timestamp())
  returning m.display_name into v_name;
  if not found then raise exception 'Party unavailable or messages are being sent too quickly' using errcode = '42501'; end if;
  insert into public.zeus_party_messages(room_code, user_id, display_name, body) values (v_code, v_user, v_name, v_body);
  -- Bound retained chat per room even if a room is very active.
  delete from public.zeus_party_messages where room_code = v_code and id < coalesce((
    select id from public.zeus_party_messages where room_code = v_code order by id desc offset 199 limit 1
  ), 0);
  perform public.zeus_party_notify(v_code);
end;
$$;
revoke all on function public.zeus_party_chat(text,text) from public, anon;
grant execute on function public.zeus_party_chat(text,text) to authenticated;

create function public.zeus_party_leave(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  -- A host who explicitly leaves pauses the shared timeline. The same
  -- authenticated host can rejoin later; guests are never promoted.
  update public.zeus_party_rooms r set
    position_seconds = least(86400, r.position_seconds + case when r.playing
      then greatest(0, extract(epoch from (clock_timestamp() - r.state_updated_at))) else 0 end),
    playing = false, state_updated_at = clock_timestamp(), revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.ended_at is null;
  delete from public.zeus_party_members where room_code = v_code and user_id = v_user;
  if found then perform public.zeus_party_notify(v_code); end if;
end;
$$;
revoke all on function public.zeus_party_leave(text) from public, anon;
grant execute on function public.zeus_party_leave(text) to authenticated;

create function public.zeus_party_end(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  update public.zeus_party_rooms r set ended_at = clock_timestamp(), playing = false, revision = revision + 1
  where r.code = v_code and r.host_id = v_user and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can end the party' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;
revoke all on function public.zeus_party_end(text) from public, anon;
grant execute on function public.zeus_party_end(text) to authenticated;

-- Make newly created RPC signatures visible to PostgREST immediately after commit.
notify pgrst, 'reload schema';
