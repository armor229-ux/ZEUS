-- Vidora exposes outgoing player events, not a remote-control API. Track
-- whether the host has actually reported its current Vidora player so guests
-- can distinguish an observation from the room's initial/default position.
-- Existing rooms remain valid, and older clients ignore this additive field.
alter table public.zeus_party_rooms add column vidora_observed boolean not null default false;

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
      'vidora_observed', r.vidora_observed,
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
    playing = false, source_id = null, vidora_observed = false, state_updated_at = clock_timestamp(), revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can change players' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;

-- This RPC is deliberately scoped to the room's current Vidora provider.
-- It stores observations, not remote playback commands. In particular, a
-- late event from an old iframe cannot overwrite a different provider.
create function public.zeus_party_vidora_update(p_code text, p_action text, p_time double precision)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_code text := upper(replace(trim(coalesce(p_code, '')), '-', ''));
begin
  if p_action is null or p_action not in ('play', 'pause', 'seek', 'sync_play', 'sync_pause', 'clear')
    or p_time is null or p_time < 0 or p_time > 86400 then
    raise exception 'Invalid Vidora observation' using errcode = '22023';
  end if;
  update public.zeus_party_rooms r set
    playing = case when p_action in ('play', 'sync_play') then true
      when p_action in ('pause', 'sync_pause', 'clear') then false else r.playing end,
    position_seconds = p_time, state_updated_at = clock_timestamp(),
    vidora_observed = (p_action <> 'clear'), revision = r.revision + 1
  where r.code = v_code and r.host_id = v_user and r.provider = 'vidora'
    and (p_action <> 'seek' or r.vidora_observed)
    and r.ended_at is null and r.expires_at > clock_timestamp()
    and exists (select 1 from public.zeus_party_members m where m.room_code = r.code and m.user_id = v_user);
  if not found then raise exception 'Only the host can report the current Vidora player' using errcode = '42501'; end if;
  perform public.zeus_party_notify(v_code);
end;
$$;
revoke all on function public.zeus_party_vidora_update(text,text,double precision) from public, anon;
grant execute on function public.zeus_party_vidora_update(text,text,double precision) to authenticated;

notify pgrst, 'reload schema';
