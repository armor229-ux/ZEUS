-- Add host-controlled source preferences without changing existing room access.
-- Source switching is best-effort: providers may fall back if unavailable.
-- Vidora is deliberately exposed as a manual-playback test, not synchronized.

alter table public.zeus_party_rooms
  add column source_sync boolean not null default true,
  add column source_id text,
  add constraint zeus_party_rooms_source_id_check check (
    source_id is null or (char_length(source_id) between 1 and 128 and source_id !~ '[[:cntrl:]]')
  );
alter table public.zeus_party_rooms drop constraint zeus_party_rooms_provider_check;
alter table public.zeus_party_rooms add constraint zeus_party_rooms_provider_check
  check (provider in ('vidspark', 'cinesrc', 'bingeapi', 'vidora'));

create or replace function public.zeus_party_snapshot(p_code text)
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
      'revision', r.revision, 'source_sync', r.source_sync, 'source_id', r.source_id,
      'ended', (r.ended_at is not null or r.expires_at <= clock_timestamp()),
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

create or replace function public.zeus_party_create(
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
  if v_name = '' or v_title = '' or p_provider is null or p_provider not in ('vidspark', 'cinesrc', 'bingeapi', 'vidora')
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

create or replace function public.zeus_party_set_provider(p_code text, p_provider text, p_time double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  if p_provider is null or p_provider not in ('vidspark', 'cinesrc', 'bingeapi', 'vidora') or p_time is null or p_time < 0 or p_time > 86400 then
    raise exception 'Invalid player selection' using errcode = '22023';
  end if;
  update public.zeus_party_rooms r set provider = p_provider, position_seconds = p_time,
    playing = false, source_id = null, state_updated_at = clock_timestamp(), revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can change players' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;

-- Only the current host, while still a member, can publish a source or toggle
-- matching. The provider argument prevents late events from a previous iframe
-- from overwriting the new provider's choice. Playback time is untouched.
create function public.zeus_party_set_source(
  p_code text, p_provider text, p_source text, p_enabled boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
  v_source text := case when p_source is null then null else trim(p_source) end;
begin
  if p_enabled is null or p_provider is null or p_provider not in ('cinesrc', 'bingeapi')
    or (v_source is not null and (char_length(v_source) not between 1 and 128 or v_source ~ '[[:cntrl:]]'))
    or (p_provider = 'bingeapi' and v_source is not null and v_source not in ('81','80','94','85','87','86','93','84','82','88','92','91')) then
    raise exception 'Invalid source selection' using errcode = '22023';
  end if;
  update public.zeus_party_rooms r set
    source_sync = p_enabled,
    source_id = case when p_enabled then v_source else null end,
    revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.provider = p_provider
    and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can change the current player source' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;
revoke all on function public.zeus_party_set_source(text,text,text,boolean) from public, anon;
grant execute on function public.zeus_party_set_source(text,text,text,boolean) to authenticated;

notify pgrst, 'reload schema';
