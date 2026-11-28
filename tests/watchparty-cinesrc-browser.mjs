// Local browser regression only. CineSrc, Supabase Auth, RPC and Realtime are
// fixtures; this is NOT evidence of live playback or Supabase authorization.
// ZEUS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
//   ZEUS_CHROMIUM_PATH=/path/to/chromium node tests/watchparty-cinesrc-browser.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.ZEUS_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CODE = '1234567890ABCDEF1234';
const users = new Map();
const calls = [];
const offline = new Set();
let room = null;
let messages = [];
let messageId = 1;
let playbackDelayMs = 0;
let playbackRequests = 0;
let server;
let browser;
let base;

function snapshot(id) {
  return { you: id, server_now: new Date().toISOString(), room: structuredClone(room),
    members: [...users.values()].map(user => ({ ...user, host: user.id === room.host_id })),
    messages: structuredClone(messages) };
}
function rpc(id, name, params) {
  calls.push({ id, name, params: structuredClone(params) });
  if (offline.has(id)) throw new Error('Network unavailable');
  if (name === 'zeus_party_create') {
    assert.equal(params.p_provider, 'cinesrc');
    room = { code: CODE, host_id: id, provider: params.p_provider, media_type: params.p_media_type,
      tmdb_id: params.p_tmdb_id, season: params.p_season, episode: params.p_episode, title: params.p_title,
      playing: false, position_seconds: 0, state_updated_at: new Date().toISOString(), revision: 0, ended: false };
    users.set(id, { id, name: params.p_name, online: true });
    return snapshot(id);
  }
  if (name === 'zeus_party_join') {
    if (!room || room.ended || params.p_code !== CODE) throw new Error('Party not found or has ended');
    users.set(id, { id, name: params.p_name, online: true });
    return snapshot(id);
  }
  if (!room || !users.has(id)) {
    const error = new Error('Party not found or access denied'); error.code = '42501'; throw error;
  }
  if (name === 'zeus_party_snapshot') return snapshot(id);
  if (name === 'zeus_party_heartbeat') return null;
  if (name === 'zeus_party_playback') {
    if (id !== room.host_id) { const error = new Error('Only the host can control playback'); error.code = '42501'; throw error; }
    room.position_seconds = params.p_time;
    room.state_updated_at = new Date().toISOString();
    room.revision++;
    if (['play', 'sync_play'].includes(params.p_action)) room.playing = true;
    if (['pause', 'sync_pause'].includes(params.p_action)) room.playing = false;
    return null;
  }
  if (name === 'zeus_party_chat') {
    messages.push({ id: messageId++, user_id: id, name: users.get(id).name, body: params.p_body });
    return null;
  }
  if (name === 'zeus_party_leave') {
    if (id === room.host_id) room.playing = false;
    users.delete(id);
    return null;
  }
  if (name === 'zeus_party_end') {
    if (id !== room.host_id) throw new Error('Only the host can end the party');
    room.ended = true; room.playing = false; room.revision++; return null;
  }
  throw new Error('Unexpected fixture RPC: ' + name);
}

const cineFixture = `<!doctype html><meta charset="utf-8"><body>
<button id="play">Play</button><button id="pause">Pause</button><button id="seek">Seek to 120</button>
<script>
const params=new URLSearchParams(location.search);
let time=Number(params.get('t')||0), paused=true;
window.commands=[];
function emit(kind,extra={}){parent.postMessage({type:'cinesrc:'+kind,...extra},'*')}
function play(){paused=false;emit('play')}
function pause(){paused=true;emit('pause')}
function seek(value){time=Number(value);emit('seeked',{currentTime:time,duration:1000})}
document.getElementById('play').onclick=play;
document.getElementById('pause').onclick=pause;
document.getElementById('seek').onclick=()=>seek(120);
addEventListener('message',event=>{const data=event.data;window.commands.push(data);
  if(data.command==='getCurrentTime')emit('response',{command:data.command,result:time});
  else if(data.command==='getPaused')emit('response',{command:data.command,result:paused});
  else if(data.command==='play')play();else if(data.command==='pause')pause();else if(data.command==='seek')seek(data.args[0]);
});
window.fixtureState=()=>({time,paused,commands:window.commands});
window.reportError=()=>emit('error',{error:'Fixture source failure'});
window.silentPause=()=>{paused=true};
window.changeEpisode=()=>emit('nextepisode',{season:2,episode:1,internalNavigation:true});
setInterval(()=>{if(!paused){time+=0.5;emit('timeupdate',{currentTime:time,duration:1000})}},500);
setTimeout(()=>emit('ready'),50);
</script></body>`;
const normalFixture = '<!doctype html><title>Normal player fixture</title><p>Normal player fixture</p>';

async function waitUntil(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(last));
}
async function wake(page) {
  await page.evaluate(() => (window.__channels || []).forEach(channel => channel.broadcast?.({ payload: {} })));
}
async function playerState(page) {
  return page.frameLocator('#party-player').locator('body').evaluate(() => window.fixtureState());
}

try {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local.test').pathname);
    const file = path.resolve(root, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(root + path.sep) || pathname.startsWith('/media/')) { response.writeHead(404).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.ZEUS_CHROMIUM_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [];
  const requests = [];

  // Load the actual vendored SDK under the page CSP without creating a
  // session or contacting Supabase. Later scenarios use explicit fixtures.
  const idleContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const idleRequests = [];
  await idleContext.route('**/*', async route => {
    if (route.request().url().startsWith(base)) await route.continue();
    else { idleRequests.push(route.request().url()); await route.abort(); }
  });
  const idlePage = await idleContext.newPage();
  const idleErrors = [];
  idlePage.on('pageerror', error => idleErrors.push(error.message));
  await idlePage.goto(base + '/party.html?party=' + CODE);
  await idlePage.waitForFunction(() => typeof window.supabase?.createClient === 'function');
  assert.equal(new URL(idlePage.url()).search, '', 'legacy query invite is scrubbed after loading');
  assert.equal(new URL(idlePage.url()).hash, '#party=' + CODE);
  assert.equal(await idlePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page fits');
  await idlePage.goto(base + '/party.html?party=' + encodeURIComponent('<img src=x onerror=alert(1)>'));
  await idlePage.waitForFunction(() => typeof window.ZeusCineSrcParty?.normalizeCode === 'function');
  assert.equal(await idlePage.locator('#invite-code').inputValue(), '', 'malicious invite is not accepted');
  assert.equal(await idlePage.locator('#lobby img').count(), 0, 'invite text is never inserted as markup');
  assert.deepEqual(idleRequests, [], 'opening the lobby alone does not contact external services');
  assert.deepEqual(idleErrors, []);
  await idleContext.close();

  async function viewer(id, viewport = { width: 1280, height: 850 }) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ id }) => {
      try { localStorage.setItem('zeus_intro_seen_v1', '1'); } catch (error) { /* optional */ }
      window.__channels = [];
      window.supabase = { createClient: (_url, _key, options) => {
        window.__usesSessionStorage = options.auth.storage === sessionStorage;
        return {
          auth: { getSession: async () => ({ data: { session: { access_token: 'fixture' } } }),
            signInAnonymously: async () => ({ data: { session: { access_token: 'fixture' } } }),
            onAuthStateChange: () => ({ data: { subscription: {} } }) },
          realtime: { setAuth: async () => {} },
          rpc: async (name, params) => {
            const response = await fetch('/__test_rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, name, params }) });
            return response.json();
          },
          channel: (topic, config) => {
            const channel = { topic, config, on(_kind, _filter, callback) { this.broadcast = callback; return this; },
              subscribe(callback) { this.status = callback; window.__channels.push(this); setTimeout(() => callback('SUBSCRIBED'), 10); return this; } };
            return channel;
          },
          removeChannel: async () => {}
        };
      } };
    }, { id });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = request.url();
      if (url.startsWith(base + '/__test_rpc')) {
        const input = JSON.parse(request.postData());
        if (input.id === 'host' && input.name === 'zeus_party_playback') {
          playbackRequests++;
          if (playbackDelayMs) await new Promise(resolve => setTimeout(resolve, playbackDelayMs));
        }
        try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: rpc(input.id, input.name, input.params), error: null }) }); }
        catch (error) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null, error: { message: error.message, code: error.code } }) }); }
      } else if (url.startsWith(base + '/vendor/supabase-2.119.2.js')) {
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* Auth and Realtime are fixtures in this test. */' });
      } else if (url.startsWith('https://cinesrc.st/')) {
        requests.push({ id, url });
        await route.fulfill({ status: 200, contentType: 'text/html', body: cineFixture });
      } else if (url.startsWith('https://vidora.ac/')) {
        requests.push({ id, url });
        await route.fulfill({ status: 200, contentType: 'text/html', body: normalFixture });
      } else if (url.startsWith(base)) await route.continue();
      else await route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(id + ': ' + error.message));
    return { context, page };
  }

  const host = await viewer('host');
  const guest = await viewer('guest');
  await host.page.goto(base + '/watch.html?id=533533&type=movie');
  await host.page.waitForSelector('#watch-party-btn');
  assert.equal(await host.page.locator('.server-item[data-server="vidora"]').count(), 1, 'normal viewing still has Vidora');
  assert.equal(await host.page.locator('.server-item[data-server]:not([data-server="vidora"])').count(), 0);
  await host.page.waitForFunction(() => document.querySelector('#player-frame')?.src.startsWith('https://vidora.ac/movie/533533'));
  await host.page.evaluate(() => {
    const probe = document.createElement('iframe'); probe.title = 'server test';
    probe.src = 'https://vidora.ac/movie/533533?fixture-probe=1'; document.body.appendChild(probe);
    window.addEventListener('pagehide', () => sessionStorage.setItem('__fixture_navigation_cleanup', JSON.stringify({
      player: document.querySelector('#player-frame')?.getAttribute('src'),
      probes: document.querySelectorAll('iframe[title="server test"]').length
    })));
  });
  await host.page.locator('#watch-party-btn').click();
  await host.page.waitForURL('**/party.html**');
  const stoppedNormal = JSON.parse(await host.page.evaluate(() => sessionStorage.getItem('__fixture_navigation_cleanup')));
  assert.deepEqual(stoppedNormal, { player: 'about:blank', probes: 0 }, 'normal player and hidden probes stop before navigation');
  assert.equal(await host.page.locator('#tmdb-id').inputValue(), '533533');
  assert.equal(await host.page.locator('select').count(), 1, 'only media type is selectable, not a party server');
  assert.equal(await host.page.locator('#party-player').count(), 1);
  await host.page.locator('#display-name').fill('Host');
  await host.page.locator('#rights').check();
  await host.page.locator('#create-button').click();
  await host.page.waitForSelector('#room:not([hidden])');
  await host.page.waitForFunction(() => document.querySelector('#party-player')?.src.startsWith('https://cinesrc.st/'));
  await host.page.waitForTimeout(700);
  assert.equal(room.provider, 'cinesrc');
  assert.equal(await host.page.locator('#room-role').textContent(), 'YOU ARE HOST');
  assert.equal(await host.page.evaluate(() => window.__usesSessionStorage), true);
  const channel = await host.page.evaluate(() => ({ topic: window.__channels[0].topic, config: window.__channels[0].config }));
  assert.equal(channel.topic, 'zeus-party:' + CODE);
  assert.equal(channel.config.config.private, true);
  await host.page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__invite = text; } } }));
  await host.page.locator('#copy-invite').click();
  const invite = new URL(await host.page.evaluate(() => window.__invite));
  assert.equal(invite.pathname, '/party.html');
  assert.equal(invite.search, '');
  assert.equal(invite.hash, '#party=' + CODE);

  await guest.page.goto(invite.href);
  assert.equal(await guest.page.locator('#join-tab').getAttribute('aria-selected'), 'true');
  await guest.page.locator('#display-name').fill('<b>Guest</b>');
  await guest.page.locator('#join-button').click();
  await guest.page.waitForSelector('#room:not([hidden])');
  await guest.page.waitForFunction(() => document.querySelector('#party-player')?.src.startsWith('https://cinesrc.st/'));
  await wake(host.page);
  await waitUntil(async () => (await host.page.locator('#member-count').textContent()) === '2', 'both participants');
  assert.equal(await guest.page.locator('#room-role').textContent(), 'GUEST');
  assert.match(await host.page.locator('#members').textContent(), /<b>Guest<\/b>/);
  assert.equal(await host.page.locator('#members b').count(), 0, 'participant names are text');

  const mobile = await viewer('mobile', { width: 375, height: 812 });
  await mobile.page.goto(base + '/party.html');
  await mobile.page.locator('#join-tab').click();
  await mobile.page.locator('#display-name').fill('Mobile');
  await mobile.page.locator('#invite-code').fill('not-a-valid-code');
  const callsBeforeInvalid = calls.length;
  await mobile.page.locator('#join-button').click();
  await waitUntil(async () => (await mobile.page.locator('#form-message').textContent()).includes('valid party code'), 'invalid code rejected');
  assert.equal(calls.length, callsBeforeInvalid, 'invalid codes do not call the backend');
  await mobile.page.locator('#invite-code').fill('1234-5678-90AB-CDEF-1234');
  await mobile.page.locator('#join-button').click();
  await mobile.page.waitForSelector('#room:not([hidden])');
  assert.equal(await mobile.page.locator('#room-role').textContent(), 'GUEST', 'joining by code works');
  await mobile.page.locator('#leave-button').click();
  await mobile.page.waitForSelector('#lobby:not([hidden])');
  await mobile.context.close();

  await guest.page.locator('#chat-input').fill('Hello <img src=x>');
  await guest.page.locator('#chat-form').evaluate(form => form.requestSubmit());
  await waitUntil(() => messages.length === 1, 'chat saved');
  await wake(host.page);
  await waitUntil(async () => (await host.page.locator('#messages').textContent()).includes('Hello <img src=x>'), 'chat delivered');
  assert.equal(await host.page.locator('#messages img').count(), 0, 'chat is rendered as text');

  await host.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(() => room.playing, 'host play');
  await wake(guest.page);
  await waitUntil(async () => !(await playerState(guest.page)).paused, 'guest play');
  await host.page.frameLocator('#party-player').locator('#pause').click();
  await waitUntil(() => !room.playing, 'host pause');
  await wake(guest.page);
  await waitUntil(async () => (await playerState(guest.page)).paused, 'guest pause');
  await host.page.frameLocator('#party-player').locator('#seek').click();
  await waitUntil(() => room.position_seconds >= 119, 'host seek');
  await wake(guest.page);
  await waitUntil(async () => (await playerState(guest.page)).time >= 119, 'guest seek');
  const denied = await guest.page.evaluate(async code => {
    const response = await fetch('/__test_rpc', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'guest', name: 'zeus_party_playback', params: { p_code: code, p_action: 'play', p_time: 900 } }) });
    return response.json();
  }, CODE);
  assert.match(denied.error.message, /Only the host/);
  await guest.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(async () => (await playerState(guest.page)).paused, 'guest returns to host pause');
  assert.equal(room.playing, false);

  // A healthy host resync must not replace a playing iframe while its play RPC
  // is still in flight, which could otherwise leave the room playing against a
  // newly paused host. Delay the fixture service to exercise that ordering.
  playbackDelayMs = 700;
  const priorRequests = playbackRequests;
  const priorCalls = calls.length;
  await host.page.evaluate(() => { window.__oldPlayer = document.getElementById('party-player'); });
  await host.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(() => playbackRequests > priorRequests, 'slow host play request');
  await host.page.locator('#resync-button').click();
  assert.equal(await host.page.evaluate(() => window.__oldPlayer === document.getElementById('party-player')), true,
    'a healthy host resync keeps the playing iframe');
  await waitUntil(() => calls.slice(priorCalls).some(call => call.name === 'zeus_party_playback' && call.params.p_action === 'sync_play'), 'ordered host resync');
  assert.equal(room.playing, true);
  assert.equal((await playerState(host.page)).paused, false);
  playbackDelayMs = 0;

  // A documented getPaused response can repair a missed pause event.
  await host.page.frameLocator('#party-player').locator('body').evaluate(() => window.silentPause());
  await waitUntil(() => !room.playing, 'getter repairs missed host pause', 16000);
  assert.ok(calls.some(call => call.name === 'zeus_party_playback' && call.params.p_action === 'sync_pause'));

  await host.page.frameLocator('#party-player').locator('body').evaluate(() => window.reportError());
  await waitUntil(async () => (await host.page.locator('#player-notice').textContent()).includes('will not switch players'), 'CineSrc error does not fall back');
  await host.page.evaluate(() => { window.__oldPlayer = document.getElementById('party-player'); });
  playbackDelayMs = 700;
  const beforeRetry = playbackRequests;
  await host.page.locator('#resync-button').click();
  await waitUntil(() => playbackRequests > beforeRetry, 'retry pauses the room first');
  assert.equal(await host.page.evaluate(() => window.__oldPlayer.isConnected), true, 'old player remains until the queued pause commits');
  await waitUntil(async () => host.page.evaluate(() => window.__oldPlayer !== document.getElementById('party-player')), 'retry replaces the failed player');
  playbackDelayMs = 0;
  assert.equal(await host.page.evaluate(() => window.__oldPlayer.isConnected), false, 'previous browsing context removed');
  assert.equal(await host.page.locator('iframe').count(), 1, 'only one party player exists');
  assert.equal(await host.page.locator('#player-frame').count(), 0, 'normal player is not hidden on the party page');
  await host.page.waitForTimeout(700);
  await host.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(() => room.playing, 'play before local episode change');
  await host.page.evaluate(() => { window.__episodePlayer = document.getElementById('party-player'); });
  await host.page.frameLocator('#party-player').locator('body').evaluate(() => window.changeEpisode());
  await waitUntil(() => !room.playing, 'host episode change pauses the room');
  assert.equal(await host.page.evaluate(() => window.__episodePlayer === document.getElementById('party-player')), true,
    'internal navigation is not immediately replaced');
  assert.match(await host.page.locator('#player-notice').textContent(), /changed episodes locally/);
  const pausesBeforeNewDocument = (await playerState(host.page)).commands.filter(command => command.command === 'pause').length;
  await host.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(async () => {
    const player = await playerState(host.page);
    return player.paused && player.commands.filter(command => command.command === 'pause').length > pausesBeforeNewDocument;
  }, 'internally navigated episode is paused again');
  assert.equal(room.playing, false, 'wrong episode is never published as room playback');
  await host.page.locator('#resync-button').click();
  await waitUntil(async () => host.page.evaluate(() => window.__episodePlayer !== document.getElementById('party-player')), 'explicit resync restores room episode');
  await host.page.waitForTimeout(700);

  // An old client may still change a legacy room's provider. The new client
  // must stop its iframe and never load that provider.
  room.provider = 'vidora'; room.revision++;
  await Promise.all([wake(host.page), wake(guest.page)]);
  await waitUntil(async () => (await guest.page.locator('#player-notice').textContent()).includes('not using CineSrc'), 'fail closed on old provider');
  assert.equal(await guest.page.locator('#party-player').count(), 0);
  assert.equal(await guest.page.locator('#resync-button').isDisabled(), true);
  const outsider = await viewer('outsider');
  await outsider.page.goto(invite.href);
  await outsider.page.locator('#display-name').fill('Outsider');
  await outsider.page.locator('#join-button').click();
  await waitUntil(async () => (await outsider.page.locator('#form-message').textContent()).includes('not a CineSrc party'), 'legacy invite rejected');
  assert.equal(users.has('outsider'), false, 'incompatible guest membership cleaned up');
  await outsider.context.close();
  room.provider = 'cinesrc'; room.revision++;
  await Promise.all([wake(host.page), wake(guest.page)]);
  await waitUntil(async () => (await guest.page.locator('#party-player').count()) === 1, 'CineSrc resumes after provider restored');
  await waitUntil(async () => (await host.page.locator('#party-player').count()) === 1, 'host CineSrc restored');
  await host.page.waitForTimeout(700);

  // Back/forward-cache retention must not leave a hidden previous iframe
  // running, and returning requires a fresh snapshot and new player.
  await guest.page.evaluate(() => {
    window.__cachedPlayer = document.getElementById('party-player');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  assert.equal(await guest.page.locator('#party-player').count(), 0);
  assert.equal(await guest.page.evaluate(() => window.__cachedPlayer.isConnected), false);
  await guest.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await waitUntil(async () => (await guest.page.locator('#party-player').count()) === 1, 'restored page creates one fresh player');
  assert.equal(await guest.page.locator('iframe').count(), 1);

  await host.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(() => room.playing, 'host play before disconnect');
  offline.add('host');
  await host.page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await waitUntil(async () => (await playerState(host.page)).paused, 'host locally paused while offline');
  offline.delete('host');
  await host.page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await waitUntil(() => !room.playing, 'reconnected host publishes pause');
  await wake(guest.page);
  assert.equal(await host.page.locator('#room-role').textContent(), 'YOU ARE HOST');
  assert.equal(await guest.page.locator('#room-role').textContent(), 'GUEST');
  await host.page.reload();
  await host.page.waitForSelector('#room:not([hidden])');
  assert.equal(await host.page.locator('#room-role').textContent(), 'YOU ARE HOST', 'same-session host survives reload');

  await guest.page.locator('#leave-button').click();
  await guest.page.waitForSelector('#lobby:not([hidden])');
  assert.equal(await guest.page.locator('#party-player').count(), 0, 'leaving destroys the player');
  await host.page.waitForTimeout(700);
  playbackDelayMs = 700;
  const beforeLeavingRequests = playbackRequests, beforeLeavingCalls = calls.length;
  await host.page.frameLocator('#party-player').locator('#play').click();
  await waitUntil(() => playbackRequests > beforeLeavingRequests, 'host play is in flight before leave');
  await host.page.locator('#leave-button').click();
  await host.page.waitForSelector('#lobby:not([hidden])');
  playbackDelayMs = 0;
  const leaveCalls = calls.slice(beforeLeavingCalls);
  const playIndex = leaveCalls.findIndex(call => call.id === 'host' && call.name === 'zeus_party_playback' && call.params.p_action === 'play');
  const leaveIndex = leaveCalls.findIndex(call => call.id === 'host' && call.name === 'zeus_party_leave');
  assert.ok(playIndex >= 0 && leaveIndex > playIndex, 'leave follows pending host playback updates');
  assert.equal(room.playing, false, 'host leave is the last room playback mutation');
  assert.equal(await host.page.locator('#party-player').count(), 0);
  assert.equal(calls.filter(call => call.name === 'zeus_party_set_provider').length, 0);
  assert.equal(calls.filter(call => call.name === 'zeus_party_set_source').length, 0);
  assert.equal(requests.filter(request => request.id !== 'host' && request.url.startsWith('https://vidora.ac/')).length, 0,
    'no party guest loads a different provider');
  assert.deepEqual(errors, []);
  console.log('PASS: CineSrc-only party UI and two-session fixture regression (mocked services; not live sync proof).');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
