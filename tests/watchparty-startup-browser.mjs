// Focused browser regressions for player startup and retry behavior.
// Both the Supabase RPCs and player iframes below are fixtures, not live services.
// Example: ZEUS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
//   ZEUS_CHROMIUM_PATH=/path/to/chromium node tests/watchparty-startup-browser.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.ZEUS_PLAYWRIGHT_MODULE || 'playwright-core');
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const code = '1234567890ABCDEF1234';
let room;
let members;
let calls;
let browser;
let server;
let base;

function startRoom(provider, playing = false, time = 0) {
  room = { code, host_id: 'host', provider, media_type: 'movie', tmdb_id: '533533',
    season: 1, episode: 1, title: 'Fixture', playing, position_seconds: time,
    state_updated_at: new Date().toISOString(), revision: 1, source_sync: false, source_id: null, ended: false };
  members = new Map([['host', { id: 'host', name: 'Host', host: true, online: true }]]);
  calls = [];
}
function snapshot(id) {
  return { you: id, server_now: new Date().toISOString(), room: structuredClone(room),
    members: [...members.values()], messages: [] };
}
function rpc(id, name, params) {
  calls.push({ id, name, params: structuredClone(params) });
  if (name === 'zeus_party_join') {
    members.set(id, { id, name: params.p_name, host: id === 'host', online: true });
    return snapshot(id);
  }
  if (name === 'zeus_party_snapshot') return snapshot(id);
  if (name === 'zeus_party_heartbeat') return null;
  if (name === 'zeus_party_playback') {
    if (id !== 'host') throw new Error('Only the host can control playback');
    room.position_seconds = params.p_time;
    room.state_updated_at = new Date().toISOString();
    room.revision++;
    if (['play', 'sync_play'].includes(params.p_action)) room.playing = true;
    if (['pause', 'sync_pause'].includes(params.p_action)) room.playing = false;
    return null;
  }
  throw new Error('Unexpected mocked RPC: ' + name);
}

// The fixtures deliberately omit some optional events. This models only the
// documented event shapes; it does not establish what a real iframe will do.
function fixture(provider, options = {}) {
  return `<!doctype html><meta charset="utf-8"><body><button id="play">Play</button><button id="pause">Pause</button><script>
    const provider = ${JSON.stringify(provider)}, options = ${JSON.stringify(options)};
    const params = new URLSearchParams(location.search);
    const loads = Number(sessionStorage.getItem('fixtureLoads') || 0) + 1;
    sessionStorage.setItem('fixtureLoads', String(loads));
    let time = Number(params.get('t') || 0), paused = true, firstEvent = false;
    window.commands = [];
    function emit(event, value) {
      if (options.noEvents) return;
      let data;
      if (provider === 'cinesrc') {
        data = {type: 'cinesrc:' + event};
        if (event === 'response') Object.assign(data, value);
        else if (event === 'sourceused') data.sourceId = 'ember';
        else if (event === 'seeked') data.currentTime = time;
        else if (event === 'error') data.error = value;
      } else {
        data = {source: 'bingeapi_player', event, info: value ?? null};
      }
      firstEvent = true;
      parent.postMessage(data, '*');
    }
    document.querySelector('#play').onclick = () => { paused = false; emit('play'); };
    document.querySelector('#pause').onclick = () => { paused = true; emit('pause'); };
    addEventListener('message', e => {
      const data = e.data;
      window.commands.push(data);
      const action = data.command;
      if (provider === 'bingeapi' && !firstEvent) return;
      if (action === 'getPaused') emit('response', {command: action, result: paused});
      else if (action === 'getCurrentTime' && !options.noCurrentTime) emit('response', {command: action, result: time});
      else if (action === 'seek') {
        time = Number(provider === 'bingeapi' ? data.value : data.args[0]);
        if (!options.noSeekEvent) emit(provider === 'bingeapi' ? 'seek' : 'seeked', time);
      } else if (action === 'play') { paused = false; emit('play'); }
      else if (action === 'pause') { paused = true; emit('pause'); }
    });
    window.fixtureState = () => ({loads, time, paused, commands: window.commands});
    window.reportFixtureError = () => emit('error', 'No source <img src=x> https://example.test/private-link');
    if (provider === 'bingeapi') setTimeout(() => emit('serverchange', 'Sirius'), 50);
    if (provider === 'cinesrc') setTimeout(() => { emit('ready'); emit('sourceused'); }, 50);
  </script></body>`;
}

async function openViewer(id, provider, options) {
  const ctx = await browser.newContext();
  await ctx.exposeBinding('__fixtureRpc', (_source, name, params) => {
    try { return { data: rpc(id, name, params), error: null }; }
    catch (error) { return { data: null, error: { message: error.message } }; }
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('zeus_intro_seen_v1', '1');
    window.supabase = { createClient: () => ({
      auth: { getSession: async () => ({data: {session: {access_token: 'fixture'}}}) },
      realtime: { setAuth: async () => {} },
      rpc: (name, params) => window.__fixtureRpc(name, params),
      channel: () => ({ on() { return this; }, subscribe(callback) { setTimeout(() => callback('SUBSCRIBED'), 10); return this; } }),
      removeChannel: async () => {}
    }) };
  });
  await ctx.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url.startsWith('https://cinesrc.st/') && provider === 'cinesrc') {
      return route.fulfill({status: 200, contentType: 'text/html', body: fixture(provider, options)});
    }
    if (url.startsWith('https://bingeapi.st/') && provider === 'bingeapi') {
      return route.fulfill({status: 200, contentType: 'text/html', body: fixture(provider, options)});
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  await page.goto(base + '/watch.html?id=533533&type=movie');
  await page.locator('#watch-party-btn').click();
  await page.locator('#wp-name').fill(id === 'host' ? 'Host' : 'Guest');
  await page.locator('#wp-code-input').fill(code);
  await page.locator('.wp-join').click();
  await page.waitForSelector('.wp-room:not([hidden])');
  await page.frameLocator('#player-frame').locator('#play').waitFor();
  return { ctx, page };
}
async function playerState(page) {
  return page.frameLocator('#player-frame').locator('body').evaluate(() => window.fixtureState());
}
async function waitUntil(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch (error) { lastError = error; } // iframe may be navigating
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Condition was not met within ' + timeout + ' ms' + (lastError ? ': ' + lastError.message : ''));
}

const failures = [];
async function scenario(label, run) {
  try { await run(); console.log('PASS:', label); }
  catch (error) { failures.push(label); console.error('FAIL:', label, '\n', error.stack); }
}
try {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/^\/+/, '');
    const file = path.resolve(publicDir, name);
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      const type = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'}[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, {'content-type': type}); res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({executablePath: process.env.ZEUS_CHROMIUM_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});

  await scenario('BingeAPI guest follows after first server event even without a seek echo', async () => {
    startRoom('bingeapi', true, 120);
    const viewer = await openViewer('guest', 'bingeapi', {noSeekEvent: true});
    try {
      await waitUntil(async () => (await playerState(viewer.page)).commands.some(c => c.command === 'seek'));
      await waitUntil(async () => (await playerState(viewer.page)).commands.some(c => c.command === 'play'));
      const state = await playerState(viewer.page);
      assert.equal(state.paused, false);
      assert.ok(state.time >= 120);
    } finally { await viewer.ctx.close(); }
  });

  for (const id of ['host', 'guest']) {
    await scenario('Resync reloads an unresponsive BingeAPI player for ' + id, async () => {
      startRoom('bingeapi', false, 120);
      const viewer = await openViewer(id, 'bingeapi', {noEvents: true});
      try {
        const before = (await playerState(viewer.page)).loads;
        await viewer.page.locator('.wp-resync').click();
        await waitUntil(async () => (await playerState(viewer.page)).loads > before);
      } finally { await viewer.ctx.close(); }
    });
    await scenario('A reported CineSrc source error remains visible and can be retried by ' + id, async () => {
      startRoom('cinesrc', false, 120);
      const viewer = await openViewer(id, 'cinesrc', {noSeekEvent: true});
      try {
        await waitUntil(async () => (await playerState(viewer.page)).commands.some(c => c.command === 'pause'));
        await viewer.page.frameLocator('#player-frame').locator('body').evaluate(() => window.reportFixtureError());
        await viewer.page.waitForFunction(() => document.querySelector('.wp-player-notice').textContent.includes('No source'), null, {timeout: 4000});
        assert.equal(await viewer.page.locator('.wp-player-notice img').count(), 0, 'player error is rendered as text');
        assert.doesNotMatch(await viewer.page.locator('.wp-player-notice').textContent(), /https:\/\/example/);
        await viewer.page.waitForTimeout(2100); // a status poll must not hide the error
        assert.match(await viewer.page.locator('.wp-player-notice').textContent(), /No source/);
        const before = (await playerState(viewer.page)).loads;
        await viewer.page.locator('.wp-resync').click();
        await waitUntil(async () => (await playerState(viewer.page)).loads > before);
      } finally { await viewer.ctx.close(); }
    });
  }

  await scenario('A player error clears when the host reports playback again', async () => {
    startRoom('cinesrc', false, 120);
    const viewer = await openViewer('host', 'cinesrc', {noSeekEvent: true});
    try {
      await waitUntil(async () => (await playerState(viewer.page)).commands.some(c => c.command === 'pause'));
      await viewer.page.frameLocator('#player-frame').locator('body').evaluate(() => window.reportFixtureError());
      await viewer.page.waitForFunction(() => document.querySelector('.wp-player-notice').textContent.includes('No source'), null, {timeout: 4000});
      await viewer.page.frameLocator('#player-frame').locator('#play').click();
      await viewer.page.waitForFunction(() => !document.querySelector('.wp-player-notice').textContent.includes('No source'), null, {timeout: 4000});
    } finally { await viewer.ctx.close(); }
  });

  await scenario('CineSrc play without a timestamp does not reset a resumed room to zero', async () => {
    startRoom('cinesrc', false, 120);
    const viewer = await openViewer('host', 'cinesrc', {noCurrentTime: true, noSeekEvent: true});
    try {
      await waitUntil(async () => (await playerState(viewer.page)).commands.some(c => c.command === 'pause'));
      await viewer.page.frameLocator('#player-frame').locator('#play').click();
      await waitUntil(() => calls.some(c => c.name === 'zeus_party_playback' && c.params.p_action === 'play'));
      const play = calls.find(c => c.name === 'zeus_party_playback' && c.params.p_action === 'play');
      assert.ok(play.params.p_time >= 119, 'missing timestamp should not become 0; got ' + play.params.p_time);
    } finally { await viewer.ctx.close(); }
  });

  for (const beforeStatus of [true, false]) {
    await scenario('A quick host play then pause is not suppressed ' +
      (beforeStatus ? 'before the first status' : 'by an older room snapshot'), async () => {
      startRoom('cinesrc', false, 120);
      const viewer = await openViewer('host', 'cinesrc', {noCurrentTime: true, noSeekEvent: true});
      try {
        if (!beforeStatus) await waitUntil(async () => (await playerState(viewer.page)).commands.some(c => c.command === 'pause'));
        await viewer.page.frameLocator('#player-frame').locator('body').evaluate(() => {
          document.querySelector('#play').click();
          document.querySelector('#pause').click();
        });
        await waitUntil(() => calls.filter(c => c.name === 'zeus_party_playback' &&
          ['play', 'pause'].includes(c.params.p_action)).length >= 2);
        const actions = calls.filter(c => c.name === 'zeus_party_playback' &&
          ['play', 'pause'].includes(c.params.p_action)).map(c => c.params.p_action);
        assert.deepEqual(actions.slice(0, 2), ['play', 'pause']);
        assert.equal(room.playing, false);
      } finally { await viewer.ctx.close(); }
    });
  }
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
console.log('Fixtures only: no live Supabase, external player, or video playback.');
if (failures.length) process.exitCode = 1;
