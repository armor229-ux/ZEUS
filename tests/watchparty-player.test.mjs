// Run with: node --test tests/watchparty-player.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const player = require('../public/watchparty-player.js');
const room = { provider: 'vidspark', tmdb_id: '533533', media_type: 'movie', season: 1, episode: 1 };

test('VidSpark and CineSrc use their documented movie and TV embed URLs', () => {
  let url = new URL(player.buildUrl(room, 123.8));
  assert.equal(url.origin, 'https://vidspark.to');
  assert.equal(url.pathname, '/movie/533533');
  assert.equal(url.searchParams.get('t'), '123');
  url = new URL(player.buildUrl({ ...room, media_type: 'tv', season: 5, episode: 3 }, 0));
  assert.equal(url.pathname, '/tv/533533/5/3');
  assert.equal(url.searchParams.get('t'), '0');
  url = new URL(player.buildUrl({ ...room, provider: 'cinesrc', media_type: 'tv', season: 2, episode: 7 }, 12));
  assert.equal(url.origin, 'https://cinesrc.st');
  assert.equal(url.pathname, '/embed/tv/533533');
  assert.equal(url.searchParams.get('s'), '2');
  assert.equal(url.searchParams.get('e'), '7');
  assert.equal(url.searchParams.get('t'), '12');
  assert.equal(url.searchParams.get('autonext'), 'false');
  assert.equal(url.searchParams.get('continueprompt'), 'false');
  url = new URL(player.buildUrl({ ...room, provider: 'cinesrc' }, 9));
  assert.equal(url.pathname, '/embed/movie/533533');
});

test('the adapter rejects untrusted IDs, providers, episodes and invalid seek times', () => {
  assert.throws(() => player.buildUrl({ ...room, tmdb_id: '1/../../evil' }, 0));
  assert.throws(() => player.buildUrl({ ...room, provider: 'https://evil.example' }, 0));
  assert.throws(() => player.buildUrl({ ...room, media_type: 'tv', season: 0 }, 0));
  assert.throws(() => player.buildUrl({ ...room, media_type: 'tv', episode: 3.5 }, 0));
  for (const invalid of [NaN, Infinity, -1, 86401, null, '']) {
    assert.deepEqual(player.commands('vidspark', 'seek', invalid), []);
  }
});

test('commands are sent only to each exact provider origin', () => {
  const calls = [];
  const frame = { contentWindow: { postMessage: (...args) => calls.push(args) } };
  player.send(frame, 'vidspark', 'seek', 123.5);
  player.send(frame, 'vidspark', 'pause');
  player.send(frame, 'cinesrc', 'play');
  player.send(frame, 'cinesrc', 'seek', 45);
  player.send(frame, 'cinesrc', 'status');
  assert.deepEqual(calls, [
    [{ action: 'seek', time: 123.5 }, 'https://vidspark.to'],
    [{ action: 'pause' }, 'https://vidspark.to'],
    [{ type: 'cinesrc:command', command: 'play', args: [] }, 'https://cinesrc.st'],
    [{ type: 'cinesrc:command', command: 'seek', args: [45] }, 'https://cinesrc.st'],
    [{ type: 'cinesrc:command', command: 'getCurrentTime', args: [] }, 'https://cinesrc.st'],
    [{ type: 'cinesrc:command', command: 'getPaused', args: [] }, 'https://cinesrc.st'],
  ]);
});

test('only messages from the expected iframe, origin and player identity are accepted', () => {
  const source = {};
  const frame = { contentWindow: source };
  const valid = { origin: 'https://vidspark.to', source, data: { source: 'vidspark-player', event: 'play', currentTime: 42 } };
  assert.deepEqual(player.readEvent(valid, frame, 'vidspark'), { kind: 'play', time: 42, paused: false, error: '' });
  assert.equal(player.readEvent({ ...valid, origin: 'https://evil.example' }, frame, 'vidspark'), null);
  assert.equal(player.readEvent({ ...valid, source: {} }, frame, 'vidspark'), null);
  assert.equal(player.readEvent({ ...valid, data: { ...valid.data, source: 'other' } }, frame, 'vidspark'), null);
  assert.equal(player.readEvent({ ...valid, data: { ...valid.data, event: 'madeup' } }, frame, 'vidspark'), null);
  assert.equal(player.readEvent(valid, frame, 'cinesrc'), null);
});

test('CineSrc getter, seek, episode and intro events match the documented API', () => {
  const source = {};
  const frame = { contentWindow: source };
  const event = (data) => ({ source, origin: 'https://cinesrc.st', data });
  assert.deepEqual(player.readEvent(event({ type: 'cinesrc:response', command: 'getPaused', result: true }), frame, 'cinesrc'),
    { kind: 'status', time: null, paused: true, error: '' });
  assert.deepEqual(player.readEvent(event({ type: 'cinesrc:response', command: 'getCurrentTime', result: 21.5 }), frame, 'cinesrc'),
    { kind: 'status', time: 21.5, paused: null, error: '' });
  assert.equal(player.readEvent(event({ type: 'cinesrc:response', command: 'getPaused', result: 'false' }), frame, 'cinesrc'), null);
  assert.equal(player.readEvent(event({ type: 'cinesrc:skipintro', time: 89 }), frame, 'cinesrc').time, 89);
  assert.equal(player.readEvent(event({ type: 'cinesrc:nextepisode', season: 2, episode: 3, internalNavigation: true }), frame, 'cinesrc').kind, 'nextepisode');
});

test('invite codes are high-entropy-looking fixed-length hex values and formatting is reversible', () => {
  const code = '1A2B3C4D5E6F7890ABCD';
  assert.equal(player.formatCode(code), '1A2B-3C4D-5E6F-7890-ABCD');
  assert.equal(player.normalizeCode(' 1a2b-3c4d-5e6f-7890-abcd '), code);
  for (const bad of ['abc', '<img onerror=alert(1)>', `${code}&host=1`, `${code}Z`, `${code}#x`]) {
    assert.equal(player.normalizeCode(bad), '');
    assert.equal(player.formatCode(bad), '');
  }
});

test('target playback compensates for server clock offset and does not advance a pause', () => {
  const paused = { position_seconds: 15, playing: false, state_updated_at: '2026-01-01T00:00:00.000Z' };
  const now = Date.parse('2026-01-01T00:00:10.000Z');
  assert.equal(player.targetTime(paused, 2000, now), 15);
  assert.equal(player.targetTime({ ...paused, playing: true }, 2000, now), 27);
  assert.equal(player.targetTime({ ...paused, playing: true }, -20000, now), 15);
  assert.equal(player.targetTime({ ...paused, position_seconds: 86399, playing: true }, 0, now), 86400);
});
