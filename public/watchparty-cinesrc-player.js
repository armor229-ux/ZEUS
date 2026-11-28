/* CineSrc-only Watch Party adapter. Public protocol: https://cinesrc.st/docs.
   The room coordinates state; this module never fetches or relays video. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZeusCineSrcParty = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const ORIGIN = 'https://cinesrc.st';

  function normalizeCode(input) {
    const code = String(input || '').trim().replace(/[\s-]/g, '').toUpperCase();
    return /^[0-9A-F]{20}$/.test(code) ? code : '';
  }

  function formatCode(input) {
    const code = normalizeCode(input);
    return code ? code.match(/.{1,4}/g).join('-') : '';
  }

  function codeFrom(input, base) {
    const direct = normalizeCode(input);
    if (direct) return direct;
    try {
      const url = new URL(String(input || '').trim(), base);
      const hash = new URLSearchParams(url.hash.slice(1));
      // Query-string invites are supported for old links, but new links put
      // the bearer code in the fragment so it is not sent in HTTP requests.
      return normalizeCode(hash.get('party') || url.searchParams.get('party') || '');
    } catch (error) { return ''; }
  }

  function inviteUrl(base, code) {
    const valid = normalizeCode(code);
    if (!valid) return '';
    try {
      const url = new URL('party.html', base);
      url.search = '';
      url.hash = 'party=' + valid;
      return url.href;
    } catch (error) { return ''; }
  }

  function finiteTime(value) {
    if (!['string', 'number'].includes(typeof value) || value === '' ||
        (typeof value === 'string' && !value.trim())) return null;
    const time = Number(value);
    return Number.isFinite(time) && time >= 0 && time <= 86400 ? time : null;
  }

  function validRoom(room) {
    if (!room || room.provider !== 'cinesrc' || !['movie', 'tv'].includes(room.media_type) ||
        !/^[0-9]{1,12}$/.test(String(room.tmdb_id))) return false;
    if (room.media_type === 'movie') return true;
    const season = Number(room.season);
    const episode = Number(room.episode);
    return Number.isInteger(season) && season >= 1 && season <= 999 &&
      Number.isInteger(episode) && episode >= 1 && episode <= 9999;
  }

  function buildUrl(room, start) {
    if (!validRoom(room)) throw new Error('Only valid CineSrc party media can be loaded.');
    const url = new URL(`/embed/${room.media_type}/${room.tmdb_id}`, ORIGIN);
    if (room.media_type === 'tv') {
      url.searchParams.set('s', String(Number(room.season)));
      url.searchParams.set('e', String(Number(room.episode)));
    }
    url.searchParams.set('t', String(Math.floor(finiteTime(start) ?? 0)));
    url.searchParams.set('continueprompt', 'false');
    url.searchParams.set('autoplay', 'false');
    url.searchParams.set('autonext', 'false');
    url.searchParams.set('autoskip', 'false');
    // CineSrc's lastserver is only a preference, not a source lock. Do not
    // expose, select, or claim to enforce an internal CineSrc server.
    return url.href;
  }

  function commands(action, time) {
    if (action === 'status') return [
      { type: 'cinesrc:command', command: 'getCurrentTime', args: [] },
      { type: 'cinesrc:command', command: 'getPaused', args: [] }
    ];
    if (!['play', 'pause', 'seek'].includes(action)) return [];
    const position = finiteTime(time);
    if (action === 'seek' && position === null) return [];
    return [{ type: 'cinesrc:command', command: action, args: action === 'seek' ? [position] : [] }];
  }

  function send(frame, action, time) {
    if (!frame || !frame.contentWindow) return;
    commands(action, time).forEach(payload => frame.contentWindow.postMessage(payload, ORIGIN));
  }

  function readEvent(event, frame) {
    if (!event || !frame || event.source !== frame.contentWindow || event.origin !== ORIGIN ||
        !event.data || typeof event.data !== 'object' || typeof event.data.type !== 'string' ||
        !event.data.type.startsWith('cinesrc:')) return null;
    const data = event.data;
    let kind = data.type.slice('cinesrc:'.length);
    let time = finiteTime(data.currentTime);
    let paused = typeof data.paused === 'boolean' ? data.paused : null;
    let error = '';
    if (kind === 'response') {
      if (data.command === 'getCurrentTime') {
        time = finiteTime(data.result);
        if (time === null) return null;
      } else if (data.command === 'getPaused' && typeof data.result === 'boolean') {
        paused = data.result;
      } else return null;
      kind = 'status';
    }
    if (kind === 'skipintro') { time = finiteTime(data.time); kind = 'seeked'; }
    if (!['ready', 'play', 'pause', 'ended', 'seeked', 'timeupdate', 'status', 'error', 'nextepisode'].includes(kind)) return null;
    if (kind === 'play') paused = false;
    if (kind === 'pause' || kind === 'ended') paused = true;
    if (kind === 'error') error = String(data.error || 'Player error').slice(0, 200);
    return { kind, time, paused, error };
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

  return { ORIGIN, normalizeCode, formatCode, codeFrom, inviteUrl, finiteTime, validRoom, buildUrl, commands, send, readEvent, targetTime };
});
