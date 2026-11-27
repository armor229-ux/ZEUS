/* Documented postMessage adapters for the party-only players.
   VidSpark: https://vidspark.to/#docs
   CineSrc: https://cinesrc.st/docs
   No iframe load event is treated as proof that video is playable. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZeusPartyPlayers = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const ORIGINS = { vidspark: 'https://vidspark.to', cinesrc: 'https://cinesrc.st' };

  function normalizeCode(input) {
    const code = String(input || '').trim().replace(/[\s-]/g, '').toUpperCase();
    return /^[0-9A-F]{20}$/.test(code) ? code : '';
  }

  function formatCode(input) {
    const code = normalizeCode(input);
    return code ? code.match(/.{1,4}/g).join('-') : '';
  }

  function finiteTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const time = Number(value);
    return Number.isFinite(time) && time >= 0 && time <= 86400 ? time : null;
  }

  function buildUrl(room, start) {
    if (!room || !ORIGINS[room.provider] || !/^[0-9]{1,12}$/.test(String(room.tmdb_id)) ||
        !['movie', 'tv'].includes(room.media_type)) throw new Error('Invalid party media');
    const id = String(room.tmdb_id);
    const season = Number(room.season);
    const episode = Number(room.episode);
    if (room.media_type === 'tv' && (!Number.isInteger(season) || season < 1 || season > 999 ||
        !Number.isInteger(episode) || episode < 1 || episode > 9999)) throw new Error('Invalid episode');
    const position = Math.floor(finiteTime(start) ?? 0);
    let url;
    if (room.provider === 'vidspark') {
      url = new URL(room.media_type === 'tv' ? `/tv/${id}/${season}/${episode}` : `/movie/${id}`, ORIGINS.vidspark);
      url.searchParams.set('t', String(position)); // overrides the player's saved resume position
      url.searchParams.set('theme', '00d4ff');
    } else {
      url = new URL(`/embed/${room.media_type}/${id}`, ORIGINS.cinesrc);
      if (room.media_type === 'tv') {
        url.searchParams.set('s', String(season));
        url.searchParams.set('e', String(episode));
      }
      url.searchParams.set('t', String(position));
      url.searchParams.set('continueprompt', 'false');
      url.searchParams.set('autoplay', 'false');
      url.searchParams.set('autonext', 'false');
    }
    return url.href;
  }

  function commands(provider, action, time) {
    if (!ORIGINS[provider]) return [];
    if (action === 'status') {
      return provider === 'vidspark'
        ? [{ action: 'getStatus' }]
        : [{ type: 'cinesrc:command', command: 'getCurrentTime', args: [] },
           { type: 'cinesrc:command', command: 'getPaused', args: [] }];
    }
    if (!['play', 'pause', 'seek'].includes(action)) return [];
    const position = finiteTime(time);
    if (action === 'seek' && position === null) return [];
    if (provider === 'vidspark') return [action === 'seek' ? { action, time: position } : { action }];
    return [{ type: 'cinesrc:command', command: action, args: action === 'seek' ? [position] : [] }];
  }

  function send(frame, provider, action, time) {
    if (!frame || !frame.contentWindow || !ORIGINS[provider]) return;
    commands(provider, action, time).forEach((payload) => frame.contentWindow.postMessage(payload, ORIGINS[provider]));
  }

  function readEvent(event, frame, provider) {
    if (!event || !frame || event.source !== frame.contentWindow || event.origin !== ORIGINS[provider] ||
        !event.data || typeof event.data !== 'object') return null;
    const data = event.data;
    let kind;
    let time = finiteTime(data.currentTime);
    let paused = typeof data.paused === 'boolean' ? data.paused : null;
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
      if (!['ready', 'play', 'pause', 'ended', 'seeked', 'timeupdate', 'status', 'error', 'nextepisode'].includes(kind)) return null;
    } else return null;
    if (kind === 'play') paused = false;
    if (kind === 'pause' || kind === 'ended') paused = true;
    return { kind, time, paused, error: kind === 'error' ? String(data.error || 'Player error').slice(0, 200) : '' };
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

  return { ORIGINS, normalizeCode, formatCode, finiteTime, buildUrl, commands, send, readEvent, targetTime };
});
