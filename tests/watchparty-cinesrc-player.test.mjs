import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const player = require('../public/watchparty-cinesrc-player.js');
const movie = { provider: 'cinesrc', media_type: 'movie', tmdb_id: '533533', season: 1, episode: 1 };

test('CineSrc is the only accepted party provider and no internal server is selected', () => {
  const url = new URL(player.buildUrl(movie, 12.8));
  assert.equal(url.origin, 'https://cinesrc.st');
  assert.equal(url.pathname, '/embed/movie/533533');
  assert.equal(url.searchParams.get('t'), '12');
  assert.equal(url.searchParams.get('autoplay'), 'false');
  assert.equal(url.searchParams.get('autonext'), 'false');
  assert.equal(url.searchParams.get('autoskip'), 'false');
  assert.equal(url.searchParams.get('continueprompt'), 'false');
  assert.equal(url.searchParams.has('lastserver'), false);
  assert.equal(url.searchParams.has('prioritize'), false);
  for (const provider of ['vidora', 'vidspark', 'bingeapi', 'native', '', null]) {
    assert.equal(player.validRoom({ ...movie, provider }), false);
    assert.throws(() => player.buildUrl({ ...movie, provider }, 0));
  }
  assert.throws(() => player.buildUrl({ ...movie, tmdb_id: '1/../../other' }, 0));
});

test('TV embeds use documented season and episode parameters and reject invalid media', () => {
  const url = new URL(player.buildUrl({ ...movie, media_type: 'tv', season: 2, episode: 7 }, 4));
  assert.equal(url.pathname, '/embed/tv/533533');
  assert.equal(url.searchParams.get('s'), '2');
  assert.equal(url.searchParams.get('e'), '7');
  for (const invalid of [
    { ...movie, media_type: 'series' }, { ...movie, tmdb_id: '' },
    { ...movie, media_type: 'tv', season: 0 }, { ...movie, media_type: 'tv', episode: 1.5 }
  ]) assert.throws(() => player.buildUrl(invalid, 0));
});

test('invites use 80-bit codes in fragments and also accept older invite links', () => {
  const code = '0123456789ABCDEF0123';
  assert.equal(player.normalizeCode('0123-4567-89ab-cdef-0123'), code);
  assert.equal(player.formatCode(code), '0123-4567-89AB-CDEF-0123');
  assert.equal(player.normalizeCode('too-short'), '');
  const invite = new URL(player.inviteUrl('https://zeus.example/watch.html?id=123', code));
  assert.equal(invite.pathname, '/party.html');
  assert.equal(invite.search, '');
  assert.equal(invite.hash, '#party=' + code);
  assert.equal(player.codeFrom(invite.href, invite.href), code);
  assert.equal(player.codeFrom('https://zeus.example/watch.html?party=' + code, invite.href), code);
  assert.equal(player.codeFrom('https://zeus.example/#party=<img>', invite.href), '');
});

test('commands use only documented CineSrc messages and exact target origin', () => {
  const calls = [];
  const frame = { contentWindow: { postMessage: (...args) => calls.push(args) } };
  player.send(frame, 'play');
  player.send(frame, 'pause');
  player.send(frame, 'seek', 45);
  player.send(frame, 'status');
  player.send(frame, 'seek', Infinity);
  player.send(frame, 'unknown');
  assert.deepEqual(calls, [
    [{ type: 'cinesrc:command', command: 'play', args: [] }, player.ORIGIN],
    [{ type: 'cinesrc:command', command: 'pause', args: [] }, player.ORIGIN],
    [{ type: 'cinesrc:command', command: 'seek', args: [45] }, player.ORIGIN],
    [{ type: 'cinesrc:command', command: 'getCurrentTime', args: [] }, player.ORIGIN],
    [{ type: 'cinesrc:command', command: 'getPaused', args: [] }, player.ORIGIN]
  ]);
});

test('player events must come from the current CineSrc iframe and valid documented shapes', () => {
  const source = {};
  const frame = { contentWindow: source };
  const event = data => ({ source, origin: player.ORIGIN, data });
  assert.deepEqual(player.readEvent(event({ type: 'cinesrc:response', command: 'getPaused', result: true }), frame),
    { kind: 'status', time: null, paused: true, error: '' });
  assert.deepEqual(player.readEvent(event({ type: 'cinesrc:response', command: 'getCurrentTime', result: 21.5 }), frame),
    { kind: 'status', time: 21.5, paused: null, error: '' });
  assert.equal(player.readEvent(event({ type: 'cinesrc:response', command: 'getCurrentTime', result: 'NaN' }), frame), null);
  assert.equal(player.readEvent(event({ type: 'cinesrc:response', command: 'getPaused', result: 'false' }), frame), null);
  assert.equal(player.readEvent(event({ type: 'cinesrc:skipintro', time: 89 }), frame).time, 89);
  assert.equal(player.readEvent(event({ type: 'cinesrc:nextepisode', internalNavigation: true }), frame).kind, 'nextepisode');
  assert.equal(player.readEvent({ ...event({ type: 'cinesrc:play' }), origin: 'https://evil.example' }, frame), null);
  assert.equal(player.readEvent({ ...event({ type: 'cinesrc:play' }), source: {} }, frame), null);
  assert.equal(player.readEvent(event({ type: 'cinesrc:sourceused', sourceId: 'anything' }), frame), null);
});

test('room time advances only while playing and rejects non-finite values', () => {
  const time = Date.parse('2026-01-01T00:00:00Z');
  const room = { position_seconds: 10, playing: true, state_updated_at: new Date(time).toISOString() };
  assert.equal(player.targetTime(room, 0, time + 4000), 14);
  assert.equal(player.targetTime({ ...room, playing: false }, 0, time + 4000), 10);
  assert.equal(player.finiteTime('NaN'), null);
  assert.equal(player.finiteTime(-1), null);
  assert.equal(player.finiteTime(86401), null);
});
