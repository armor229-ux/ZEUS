// Extra contracts for experimental party providers and source matching.
// Run with: node --test tests/watchparty-player*.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const player = require('../public/watchparty-player.js');
const movie = { provider: 'cinesrc', tmdb_id: '533533', media_type: 'movie', season: 1, episode: 1 };

test('CineSrc follows an encoded reported server only when matching is enabled', () => {
  const selected = { ...movie, source_sync: true, source_id: 'Wave & friends' };
  let url = new URL(player.buildUrl(selected, 123.9));
  assert.equal(url.searchParams.get('lastserver'), 'Wave & friends');
  assert.equal(url.searchParams.get('prioritize'), 'true');
  assert.equal(url.searchParams.get('t'), '123');
  url = new URL(player.buildUrl({ ...selected, source_sync: false }, 0));
  assert.equal(url.searchParams.has('lastserver'), false);
  assert.equal(url.searchParams.has('prioritize'), false);
  for (const bad of ['', '\n', 'x'.repeat(129), {}, null]) {
    url = new URL(player.buildUrl({ ...selected, source_id: bad }, 0));
    assert.equal(url.searchParams.has('lastserver'), false);
  }
  const frame = { contentWindow: {} };
  const event = (sourceId) => ({ origin: 'https://cinesrc.st', source: frame.contentWindow, data: { type: 'cinesrc:sourceused', sourceId } });
  assert.equal(player.readEvent(event('Wave'), frame, 'cinesrc').sourceId, 'Wave');
  assert.equal(player.readEvent(event({ id: 'Wave' }), frame, 'cinesrc').sourceId, '');
  assert.equal(player.readEvent({ ...event('Wave'), origin: 'https://evil.example' }, frame, 'cinesrc'), null);
  assert.equal(player.readEvent({ ...event('Wave'), source: {} }, frame, 'cinesrc'), null);
});

test('BingeAPI movie/episode URLs use documented options and preferred server numbers', () => {
  const room = { ...movie, provider: 'bingeapi' };
  let url = new URL(player.buildUrl(room, 90));
  assert.equal(url.origin, 'https://bingeapi.st');
  assert.equal(url.pathname, '/embed/movie/533533');
  assert.equal(url.searchParams.get('servers'), '80,94,87,84,88');
  assert.equal(url.searchParams.get('resume'), '0');
  assert.equal(url.searchParams.get('autoplay'), '0');
  assert.equal(url.searchParams.get('autonext'), '0');
  assert.equal(url.searchParams.get('next'), '0');
  assert.equal(url.searchParams.get('episodes'), '0');
  url = new URL(player.buildUrl({ ...room, media_type: 'tv', season: 2, episode: 7, source_sync: true, source_id: 'Tarazed' }, 9));
  assert.equal(url.pathname, '/embed/tv/533533/2/7');
  assert.equal(url.searchParams.get('servers'), '94');
  url = new URL(player.buildUrl({ ...room, source_sync: false, source_id: '94' }, 0));
  assert.equal(url.searchParams.get('servers'), '80,94,87,84,88');
  assert.equal(player.normalizeSource('bingeapi', 'Sirius'), '80');
  assert.equal(player.normalizeSource('bingeapi', 87), '87');
  assert.equal(player.sourceLabel('bingeapi', '87'), 'Yildun');
  for (const value of ['Unknown', '80,94', '__proto__', 'constructor', 'toString', 999]) {
    assert.equal(player.normalizeSource('bingeapi', value), '');
  }
});

test('BingeAPI maps documented commands and events and rejects forged senders', () => {
  const calls = [];
  const source = { postMessage: (...args) => calls.push(args) };
  const frame = { contentWindow: source };
  player.send(frame, 'bingeapi', 'play');
  player.send(frame, 'bingeapi', 'pause');
  player.send(frame, 'bingeapi', 'seek', 42.5);
  player.send(frame, 'bingeapi', 'status'); // no documented status command
  assert.deepEqual(calls, [
    [{ source: 'bingeapi_player_command', command: 'play' }, 'https://bingeapi.st'],
    [{ source: 'bingeapi_player_command', command: 'pause' }, 'https://bingeapi.st'],
    [{ source: 'bingeapi_player_command', command: 'seek', value: 42.5 }, 'https://bingeapi.st']
  ]);
  const event = (kind, info) => ({ origin: 'https://bingeapi.st', source, data: { source: 'bingeapi_player', event: kind, info } });
  assert.deepEqual(player.readEvent(event('time', 12.5), frame, 'bingeapi'), { kind: 'timeupdate', time: 12.5, paused: null, error: '' });
  assert.deepEqual(player.readEvent(event('seek', 30), frame, 'bingeapi'), { kind: 'seeked', time: 30, paused: null, error: '' });
  assert.deepEqual(player.readEvent(event('play', null), frame, 'bingeapi'), { kind: 'play', time: null, paused: false, error: '' });
  assert.deepEqual(player.readEvent(event('serverchange', 'Tarazed'), frame, 'bingeapi'), { kind: 'sourceused', time: null, paused: null, error: '', sourceId: '94' });
  assert.equal(player.readEvent(event('serverchange', 'unknown'), frame, 'bingeapi').sourceId, '');
  assert.match(player.readEvent(event('error', 'No sources'), frame, 'bingeapi').error, /No sources/);
  assert.equal(player.readEvent({ ...event('play', null), source: {} }, frame, 'bingeapi'), null);
  assert.equal(player.readEvent({ ...event('play', null), origin: 'https://bingeapi.st.evil.example' }, frame, 'bingeapi'), null);
  assert.equal(player.readEvent({ ...event('play', null), data: { source: 'different', event: 'play' } }, frame, 'bingeapi'), null);
});

test('Vidora party mode sends no invented remote controls and parses outgoing events', () => {
  const room = { ...movie, provider: 'vidora', media_type: 'tv', season: 2, episode: 3 };
  const url = new URL(player.buildUrl(room, 61.9));
  assert.equal(url.origin, 'https://vidora.ac');
  assert.equal(url.pathname, '/tv/533533/2/3');
  assert.equal(url.searchParams.get('startAt'), '61');
  assert.equal(url.searchParams.get('autoplay'), 'false');
  for (const action of ['status', 'play', 'pause', 'seek', 'setServer']) {
    assert.deepEqual(player.commands('vidora', action, 15), []);
  }
  const source = {};
  const frame = { contentWindow: source };
  const event = { origin: 'https://vidora.ac', source, data: { type: 'PLAYER_EVENT', data: { event: 'seeked', currentTime: 25, duration: 900, tmdbId: 533533, mediaType: 'tv', season: 2, episode: 3 } } };
  assert.deepEqual(player.readEvent(event, frame, 'vidora'), { kind: 'seeked', time: 25, paused: null, error: '' });
  assert.equal(player.readEvent({ ...event, origin: 'https://evil.example' }, frame, 'vidora'), null);
  assert.equal(player.readEvent({ ...event, source: {} }, frame, 'vidora'), null);
  assert.equal(player.readEvent({ ...event, data: { type: 'MEDIA_DATA', data: {} } }, frame, 'vidora'), null);
});

test('prototype names cannot stand in for a provider and invalid times do not become zero', () => {
  for (const bad of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => player.buildUrl({ ...movie, provider: bad }, 0));
    assert.deepEqual(player.commands(bad, 'play'), []);
    player.send({ contentWindow: { postMessage() { throw new Error('sent to invalid provider'); } } }, bad, 'play');
  }
  for (const value of [false, true, {}, [], '  ', NaN, Infinity, -1, 86401]) {
    assert.equal(player.finiteTime(value), null);
  }
});
