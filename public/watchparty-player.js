/* Documented postMessage adapters for the party-only players.
   VidSpark: https://vidspark.to/#docs
   CineSrc: https://cinesrc.st/docs
   BingeAPI: https://bingeapi.com/docs/
   Vidora: https://vidora.ac/#docs (outgoing events only; manual playback).
   No iframe load event is treated as proof that video is playable. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZeusPartyPlayers = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const ORIGINS = {
    vidspark: 'https://vidspark.to', cinesrc: 'https://cinesrc.st',
    bingeapi: 'https://bingeapi.st', vidora: 'https://vidora.ac'
  };
  const LABELS = { vidspark: 'VidSpark', cinesrc: 'CineSrc', bingeapi: 'BingeAPI', vidora: 'Vidora' };
  // Public, documented BingeAPI server names and their URL option numbers.
  // A source not on this list is not claimed as matching until documented.
  const BINGE_SERVERS = {
    aldebaran: '81', sirius: '80', tarazed: '94', markab: '85', yildun: '87', vega: '86',
    mira: '93', wezen: '84', fomalhaut: '82', nashira: '88', botein: '92', ogma: '91'
  };

  function normalizeCode(input) {
    const code = String(input || '').trim().replace(/[\s-]/g, '').toUpperCase();
    return /^[0-9A-F]{20}$/.test(code) ? code : '';
  }

  function formatCode(input) {
    const code = normalizeCode(input);
    return code ? code.match(/.{1,4}/g).join('-') : '';
  }

  function finiteTime(value) {
    if (!['string', 'number'].includes(typeof value) || value === '' || (typeof value === 'string' && !value.trim())) return null;
    const time = Number(value);
    return Number.isFinite(time) && time >= 0 && time <= 86400 ? time : null;
  }

  function hasProvider(provider) {
    return Object.prototype.hasOwnProperty.call(ORIGINS, provider);
  }

  function supportsSource(provider) {
    return provider === 'cinesrc' || provider === 'bingeapi';
  }

  function normalizeSource(provider, value) {
    if (!supportsSource(provider) || !['string', 'number'].includes(typeof value)) return '';
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return '';
    const text = String(value).trim();
    if (!text || text.length > 128 || /[\x00-\x1f\x7f]/.test(text)) return '';
    if (provider === 'cinesrc') return text; // opaque sourceId from the documented event
    const name = text.toLowerCase();
    const named = Object.prototype.hasOwnProperty.call(BINGE_SERVERS, name) ? BINGE_SERVERS[name] : '';
    return named || (Object.values(BINGE_SERVERS).includes(text) ? text : '');
  }

  function sourceLabel(provider, value) {
    const source = normalizeSource(provider, value);
    if (!source) return '';
    if (provider === 'bingeapi') {
      const name = Object.keys(BINGE_SERVERS).find((key) => BINGE_SERVERS[key] === source);
      return name ? name[0].toUpperCase() + name.slice(1) : source;
    }
    return source;
  }

  function buildUrl(room, start) {
    if (!room || !hasProvider(room.provider) || !/^[0-9]{1,12}$/.test(String(room.tmdb_id)) ||
        !['movie', 'tv'].includes(room.media_type)) throw new Error('Invalid party media');
    const id = String(room.tmdb_id);
    const season = Number(room.season);
    const episode = Number(room.episode);
    if (room.media_type === 'tv' && (!Number.isInteger(season) || season < 1 || season > 999 ||
        !Number.isInteger(episode) || episode < 1 || episode > 9999)) throw new Error('Invalid episode');
    const position = Math.floor(finiteTime(start) ?? 0);
    const preferred = room.source_sync ? normalizeSource(room.provider, room.source_id) : '';
    let url;
    if (room.provider === 'vidspark') {
      url = new URL(room.media_type === 'tv' ? `/tv/${id}/${season}/${episode}` : `/movie/${id}`, ORIGINS.vidspark);
      url.searchParams.set('t', String(position)); // overrides the player's saved resume position
      url.searchParams.set('theme', '00d4ff');
    } else if (room.provider === 'cinesrc') {
      url = new URL(`/embed/${room.media_type}/${id}`, ORIGINS.cinesrc);
      if (room.media_type === 'tv') {
        url.searchParams.set('s', String(season));
        url.searchParams.set('e', String(episode));
      }
      url.searchParams.set('t', String(position));
      url.searchParams.set('continueprompt', 'false');
      url.searchParams.set('autoplay', 'false');
      url.searchParams.set('autonext', 'false');
      if (preferred) {
        url.searchParams.set('lastserver', preferred);
        url.searchParams.set('prioritize', 'true');
      }
    } else if (room.provider === 'bingeapi') {
      url = new URL(room.media_type === 'tv' ? `/embed/tv/${id}/${season}/${episode}` : `/embed/movie/${id}`, ORIGINS.bingeapi);
      url.searchParams.set('autoplay', '0');
      url.searchParams.set('resume', '0');
      url.searchParams.set('autonext', '0');
      url.searchParams.set('next', '0');
      url.searchParams.set('episodes', '0');
      url.searchParams.set('color', '00d4ff');
      // Preferred servers are tried first, not forced; the player can fall back.
      url.searchParams.set('servers', preferred || '80,94,87,84,88');
    } else {
      url = new URL(room.media_type === 'tv' ? `/tv/${id}/${season}/${episode}` : `/movie/${id}`, ORIGINS.vidora);
      url.searchParams.set('startAt', String(position));
      url.searchParams.set('autoplay', 'false');
      url.searchParams.set('nextbutton', 'false');
    }
    return url.href;
  }

  function commands(provider, action, time) {
    if (!hasProvider(provider) || provider === 'vidora') return [];
    if (action === 'status') {
      if (provider === 'vidspark') return [{ action: 'getStatus' }];
      if (provider === 'cinesrc') return [{ type: 'cinesrc:command', command: 'getCurrentTime', args: [] },
        { type: 'cinesrc:command', command: 'getPaused', args: [] }];
      return []; // BingeAPI does not document a status getter.
    }
    if (!['play', 'pause', 'seek'].includes(action)) return [];
    const position = finiteTime(time);
    if (action === 'seek' && position === null) return [];
    if (provider === 'vidspark') return [action === 'seek' ? { action, time: position } : { action }];
    if (provider === 'bingeapi') {
      return [action === 'seek'
        ? { source: 'bingeapi_player_command', command: action, value: position }
        : { source: 'bingeapi_player_command', command: action }];
    }
    return [{ type: 'cinesrc:command', command: action, args: action === 'seek' ? [position] : [] }];
  }

  function send(frame, provider, action, time) {
    if (!frame || !frame.contentWindow || !hasProvider(provider)) return;
    commands(provider, action, time).forEach((payload) => frame.contentWindow.postMessage(payload, ORIGINS[provider]));
  }

  function readEvent(event, frame, provider) {
    if (!hasProvider(provider) || !event || !frame || event.source !== frame.contentWindow || event.origin !== ORIGINS[provider] ||
        !event.data || typeof event.data !== 'object') return null;
    const data = event.data;
    let kind;
    let time = finiteTime(data.currentTime);
    let paused = typeof data.paused === 'boolean' ? data.paused : null;
    let error = '';
    let sourceId;
    if (provider === 'vidspark') {
      if (data.source !== 'vidspark-player') return null;
      kind = data.event;
      if (!['play', 'pause', 'ended', 'seeked', 'timeupdate', 'playerstatus'].includes(kind)) return null;
    } else if (provider === 'cinesrc') {
      if (typeof data.type !== 'string' || !data.type.startsWith('cinesrc:')) return null;
      kind = data.type.slice('cinesrc:'.length);
      if (kind === 'response') {
        if (data.command === 'getCurrentTime') time = finiteTime(data.result);
        else if (data.command === 'getPaused' && typeof data.result === 'boolean') paused = data.result;
        else return null;
        kind = 'status';
      }
      if (kind === 'skipintro') { time = finiteTime(data.time); kind = 'seeked'; }
      if (kind === 'sourceused') sourceId = normalizeSource(provider, data.sourceId);
      if (!['ready', 'play', 'pause', 'ended', 'seeked', 'timeupdate', 'status', 'error', 'nextepisode', 'sourceused'].includes(kind)) return null;
      if (kind === 'error') error = String(data.error || 'Player error').slice(0, 200);
    } else if (provider === 'bingeapi') {
      if (data.source !== 'bingeapi_player') return null;
      kind = data.event;
      if (kind === 'time') { kind = 'timeupdate'; time = finiteTime(data.info); }
      else if (kind === 'seek') { kind = 'seeked'; time = finiteTime(data.info); }
      else if (kind === 'serverchange') { kind = 'sourceused'; sourceId = normalizeSource(provider, data.info); }
      else if (kind === 'error') error = String(data.info || 'Player error').slice(0, 200);
      if (!['play', 'pause', 'ended', 'timeupdate', 'seeked', 'sourceused', 'error'].includes(kind)) return null;
    } else if (provider === 'vidora') {
      if (data.type !== 'PLAYER_EVENT' || !data.data || typeof data.data !== 'object') return null;
      kind = data.data.event;
      time = finiteTime(data.data.currentTime);
      if (!['play', 'pause', 'ended', 'seeked', 'timeupdate'].includes(kind)) return null;
    } else return null;
    if (kind === 'play') paused = false;
    if (kind === 'pause' || kind === 'ended') paused = true;
    const result = { kind, time, paused, error };
    if (kind === 'sourceused') result.sourceId = sourceId || '';
    return result;
  }

  function targetTime(room, serverOffsetMs, nowMs) {
    if (!room) return 0;
    const position = finiteTime(room.position_seconds) ?? 0;
    const updatedAt = Date.parse(room.state_updated_at);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const elapsed = room.playing && Number.isFinite(updatedAt)
      ? Math.max(0, (now + (Number(serverOffsetMs) || 0) - updatedAt) / 1000) : 0;
    return Math.min(86400, position + elapsed);
  }

  // A Vidora event is useful only if it identifies the room's media. In TV
  // rooms an omitted episode cannot establish that the host stayed on the
  // shared episode; fail closed rather than publishing a different stream.
  function vidoraMediaMatch(media, room) {
    if (!media || !room) return 'unconfirmed';
    const id = room.tmdb_id ?? room.id;
    const type = room.media_type ?? room.type;
    if (media.tmdbId != null && String(media.tmdbId) !== String(id)) return 'different';
    if (media.mediaType != null && media.mediaType !== type) return 'different';
    if (type === 'tv') {
      if (media.season != null && Number(media.season) !== Number(room.season)) return 'different';
      if (media.episode != null && Number(media.episode) !== Number(room.episode)) return 'different';
      if (media.season == null || media.episode == null) return 'unconfirmed';
    }
    return media.tmdbId == null || media.mediaType == null ? 'unconfirmed' : 'match';
  }

  // Do not extrapolate a playing clock forever after the host player stops
  // reporting events or the network drops. A paused observation can stay valid
  // without timeupdate events; the UI separately checks host/room connectivity.
  function vidoraClock(room, serverOffsetMs, nowMs) {
    if (!room || room.vidora_observed !== true) return { status: 'waiting', time: null };
    const position = finiteTime(room.position_seconds);
    if (position === null) return { status: 'waiting', time: null };
    if (!room.playing) return { status: 'ready', time: position };
    const updated = Date.parse(room.state_updated_at);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const age = Number.isFinite(updated) ? Math.max(0, now + (Number(serverOffsetMs) || 0) - updated) : Infinity;
    if (age > 24000) return { status: 'stale', time: position };
    return { status: 'ready', time: Math.min(86400, position + age / 1000) };
  }

  function formatTime(value) {
    const time = finiteTime(value);
    if (time === null) return '–:––';
    const seconds = Math.floor(time);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
  }

  return { ORIGINS, LABELS, normalizeCode, formatCode, finiteTime, supportsSource, normalizeSource, sourceLabel, buildUrl, commands, send, readEvent, targetTime, vidoraMediaMatch, vidoraClock, formatTime };
});
