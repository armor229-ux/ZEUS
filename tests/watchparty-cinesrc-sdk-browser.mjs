// Browser contract smoke with the actual vendored Supabase SDK, but mocked
// Auth, PostgREST, Realtime WebSocket and CineSrc. It makes no live requests
// and is NOT evidence that real Supabase or video synchronization works.
// ZEUS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
//   ZEUS_CHROMIUM_PATH=/path/to/chromium node tests/watchparty-cinesrc-sdk-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.ZEUS_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const project = 'https://gqjgmniwvqcpsurzmbet.supabase.co';
const code = '1234567890ABCDEF1234';
const userId = '00000000-0000-4000-8000-000000000101';
const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
const expires = Math.floor(Date.now() / 1000) + 3600;
// Deliberately fake token for the fully intercepted fixture transport.
const token = [encode({ alg: 'none', typ: 'JWT' }), encode({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }), 'fixture'].join('.');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', is_anonymous: true,
  app_metadata: { provider: 'anonymous', providers: ['anonymous'] }, user_metadata: {}, identities: [], created_at: new Date().toISOString() };
const fakeSession = { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: expires, refresh_token: 'fixture-refresh-token', user };
const fakePlayer = `<!doctype html><body><script>
let time=0,paused=true;
function emit(type,more={}){parent.postMessage({type:'cinesrc:'+type,...more},'*')}
addEventListener('message',({data})=>{
 if(data.command==='getCurrentTime')emit('response',{command:data.command,result:time});
 if(data.command==='getPaused')emit('response',{command:data.command,result:paused});
 if(data.command==='seek'){time=data.args[0];emit('seeked',{currentTime:time})}
 if(data.command==='play'){paused=false;emit('play')}
 if(data.command==='pause'){paused=true;emit('pause')}
});
setTimeout(()=>emit('ready'),50);
</script></body>`;

let room;
let server;
let browser;
const requests = [];
const unexpected = [];
const joins = [];
let socket;
let protocolArrays = false;
function snapshot() {
  return { you: userId, server_now: new Date().toISOString(), room: structuredClone(room),
    members: [{ id: userId, name: 'SDK host', host: true, online: true }], messages: [] };
}
async function waitUntil(check, label, timeout = 10000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + label);
}

try {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || name.startsWith('media/')) { res.writeHead(404).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.ZEUS_CHROMIUM_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  // Mock every WebSocket; no connection is forwarded to the real project.
  await context.routeWebSocket('**/*', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const decoded = JSON.parse(String(raw));
      protocolArrays = Array.isArray(decoded);
      const message = Array.isArray(decoded)
        ? { join_ref: decoded[0], ref: decoded[1], topic: decoded[2], event: decoded[3], payload: decoded[4] }
        : decoded;
      if (message.event === 'phx_join') joins.push(message);
      if (message.ref && ['phx_join', 'phx_leave', 'heartbeat', 'access_token'].includes(message.event)) {
        const payload = { status: 'ok', response: {} };
        const reply = JSON.stringify(Array.isArray(decoded)
          ? [message.join_ref, message.ref, message.topic, 'phx_reply', payload]
          : { topic: message.topic, event: 'phx_reply', ref: message.ref, join_ref: message.join_ref, payload });
        // Real unsubscription is asynchronous; expose accidental channel reuse.
        if (message.event === 'phx_leave') setTimeout(() => ws.send(reply), 400);
        else ws.send(reply);
      }
    });
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(base)) { await route.continue(); return; }
    if (url.startsWith('https://cinesrc.st/')) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fakePlayer }); return;
    }
    if (!url.startsWith(project + '/')) { unexpected.push(url); await route.abort(); return; }
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const pathname = new URL(url).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    requests.push({ pathname, method: request.method(), body, headers: request.headers() });
    let result;
    if (pathname === '/auth/v1/signup') result = fakeSession;
    else if (pathname === '/rest/v1/rpc/zeus_party_create') {
      assert.equal(body.p_provider, 'cinesrc');
      room = { code, host_id: userId, provider: body.p_provider, media_type: body.p_media_type,
        tmdb_id: body.p_tmdb_id, season: body.p_season, episode: body.p_episode, title: body.p_title,
        playing: false, position_seconds: 0, state_updated_at: new Date().toISOString(), revision: 0, ended: false };
      result = snapshot();
    } else if (pathname === '/rest/v1/rpc/zeus_party_snapshot' || pathname === '/rest/v1/rpc/zeus_party_join') result = snapshot();
    else if (pathname === '/rest/v1/rpc/zeus_party_playback') {
      room.position_seconds = body.p_time;
      room.playing = ['play', 'sync_play'].includes(body.p_action);
      room.state_updated_at = new Date().toISOString(); room.revision++;
      result = null;
    } else if (pathname === '/rest/v1/rpc/zeus_party_heartbeat' || pathname === '/rest/v1/rpc/zeus_party_leave') result = null;
    else { unexpected.push(pathname); await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(result) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
  });
  await page.goto(base + '/party.html');
  await page.waitForFunction(() => typeof window.supabase?.createClient === 'function');
  await page.evaluate(() => {
    const actual = window.supabase;
    // Keep the real SDK, but delay the documented removeChannel operation so
    // reconnect must wait instead of accidentally reusing an old channel.
    window.supabase = { ...actual, createClient(...args) {
      const client = actual.createClient(...args);
      const remove = client.removeChannel.bind(client);
      client.removeChannel = async channel => { await new Promise(resolve => setTimeout(resolve, 400)); return remove(channel); };
      return client;
    } };
  });
  await page.locator('#display-name').fill('SDK host');
  await page.locator('#video-name').fill('Fixture title');
  await page.locator('#tmdb-id').fill('12345');
  await page.locator('#rights').check();
  await page.locator('#create-button').click();
  await page.waitForSelector('#room:not([hidden])');
  try { await waitUntil(() => joins.length > 0, 'mock private WebSocket join'); }
  catch (error) {
    console.error('Fixture diagnostics:', { socketIntercepted: !!socket, errors,
      connection: await page.locator('#connection-text').textContent(),
      requestPaths: requests.map(request => request.pathname), unexpected });
    throw error;
  }
  await waitUntil(async () => (await page.locator('#connection-text').textContent()).startsWith('Connected'), 'mock Realtime subscription');
  assert.equal(joins[0].topic, 'realtime:zeus-party:' + code);
  assert.equal(joins[0].payload.config.private, true);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('zeus_party_auth_v1')).access_token), token,
    'SDK persists the fake session only in the tab');
  assert.ok(requests.some(request => request.pathname === '/auth/v1/signup'));
  const create = requests.find(request => request.pathname === '/rest/v1/rpc/zeus_party_create');
  assert.equal(create.headers.authorization, 'Bearer ' + token);
  assert.match(create.headers.apikey, /^sb_publishable_/);
  assert.equal(create.body.p_provider, 'cinesrc');
  assert.equal(await page.locator('#room-role').textContent(), 'YOU ARE HOST');
  const priorSnapshots = requests.filter(request => request.pathname === '/rest/v1/rpc/zeus_party_snapshot').length;
  const broadcast = { event: 'changed', payload: {} };
  socket.send(JSON.stringify(protocolArrays ? [null, null, joins[0].topic, 'broadcast', broadcast]
    : { topic: joins[0].topic, event: 'broadcast', ref: null, payload: broadcast }));
  await waitUntil(() => requests.filter(request => request.pathname === '/rest/v1/rpc/zeus_party_snapshot').length > priorSnapshots,
    'mock Broadcast triggers an authorized snapshot request');
  const joinsBeforeReconnect = joins.length;
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
  await waitUntil(() => joins.length > joinsBeforeReconnect, 'new private channel after asynchronous unsubscription', 1500);
  await waitUntil(async () => (await page.locator('#connection-text').textContent()).startsWith('Connected'), 'mock Realtime reconnect');
  assert.equal(joins.length, joinsBeforeReconnect + 1, 'overlapping reconnect attempts create one channel');
  const joinsBeforeRejoin = joins.length;
  await page.locator('#leave-button').click();
  await page.waitForSelector('#lobby:not([hidden])');
  await page.locator('#join-tab').click();
  await page.locator('#invite-code').fill(code);
  await page.locator('#join-button').click();
  await page.waitForSelector('#room:not([hidden])');
  await waitUntil(() => joins.length > joinsBeforeRejoin, 'same-topic rejoin waits for old channel removal', 1500);
  assert.deepEqual(await page.evaluate(() => window.__violations), [], 'the actual SDK works under the page CSP in the fixture');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, [], 'no unhandled external requests were allowed');
  await context.close();
  console.log('PASS: vendored Supabase SDK/CSP contract with intercepted fixtures only; no real services were contacted.');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
