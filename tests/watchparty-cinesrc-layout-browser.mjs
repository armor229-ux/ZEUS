// Visual-layout regression for the party page. All external requests are
// blocked; the displayed room is populated directly in the DOM, not created
// in Supabase. This is not a live playback or synchronization test.
// ZEUS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
//   ZEUS_CHROMIUM_PATH=/path/to/chromium node tests/watchparty-cinesrc-layout-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.ZEUS_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const viewports = [320, 375, 600, 768, 900, 1024, 1440];
let server;
let browser;

try {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || pathname.startsWith('/media/') || pathname.includes('direct-party')) {
      response.writeHead(404).end(); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.ZEUS_CHROMIUM_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const width of viewports) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const external = [], errors = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(base + '/')) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/party.html');
    await page.waitForFunction(() => typeof window.ZeusCineSrcParty?.normalizeCode === 'function');
    assert.equal(await page.locator('#party-player').count(), 1, 'one existing player at ' + width);
    assert.equal(await page.locator('#party-player').isHidden(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'lobby fits at ' + width);

    // Existing keyboard interaction and the visible focus indicator are kept.
    await page.locator('#create-tab').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#join-tab').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#join-form').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'join-tab');
    const focus = await page.locator('#join-tab').evaluate(element => {
      const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.notEqual(focus.style, 'none', 'keyboard focus is visible at ' + width);
    assert.ok(focus.width >= 2, 'keyboard focus has a clear outline at ' + width);
    await page.keyboard.press('ArrowLeft');
    await page.locator('#media-type').selectOption('tv');
    assert.equal(await page.locator('#episode-fields').isVisible(), true, 'TV fields remain available');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'TV form fits at ' + width);

    // Show a representative room without calling a service or changing the app.
    await page.evaluate(() => {
      const byId = id => document.getElementById(id);
      byId('lobby').hidden = true; byId('room').hidden = false; byId('resync-button').hidden = false;
      byId('room-title').textContent = 'A long party title that should wrap without pushing controls out of view';
      byId('room-role').textContent = 'YOU ARE HOST';
      byId('room-code').textContent = '1234-5678-90AB-CDEF-1234';
      byId('connection-dot').dataset.state = 'ready';
      byId('connection-text').textContent = 'Connected · checking room state';
      byId('member-count').textContent = '3';
      for (const name of ['Alex (you)', 'A guest with a longer name', 'Maya']) {
        const member = document.createElement('li'); member.className = 'member';
        const avatar = document.createElement('span'); avatar.className = 'member-avatar'; avatar.textContent = name[0];
        const label = document.createElement('span'); label.className = 'member-name'; label.textContent = name;
        member.append(avatar, label); byId('members').append(member);
      }
      byId('messages').replaceChildren();
      for (let i = 0; i < 4; i++) {
        const message = document.createElement('div'); message.className = 'message';
        const name = document.createElement('strong'); name.textContent = 'Guest';
        const text = document.createElement('span'); text.textContent = 'A'.repeat(160);
        message.append(name, text); byId('messages').append(message);
      }
      byId('video-title').textContent = 'A long party title that should not push the Resync button away';
      byId('video-subtitle').textContent = 'You control playback for the room';
      byId('end-button').hidden = false; byId('screen-empty').hidden = true; byId('party-player').hidden = false;
    });
    const metrics = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const screen = rect('screen'), player = rect('party-player'), chat = rect('messages');
      const panel = document.querySelector('.panel').getBoundingClientRect();
      const messages = document.getElementById('messages');
      return { width: document.documentElement.scrollWidth, viewport: innerWidth, screen, player, chat,
        chatScrollHeight: messages.scrollHeight, chatClientHeight: messages.clientHeight,
        panel: { x: panel.x, y: panel.y, right: panel.right, bottom: panel.bottom } };
    });
    assert.ok(metrics.width <= metrics.viewport, 'room and long messages fit at ' + width);
    assert.ok(metrics.chat.width >= 200 && metrics.chat.height >= 180, 'chat remains usable at ' + width);
    assert.ok(metrics.chatScrollHeight > metrics.chatClientHeight, 'long chat remains scrollable at ' + width);
    assert.ok(Math.abs(metrics.screen.width - metrics.player.width) <= 2 &&
      Math.abs(metrics.screen.height - metrics.player.height) <= 2, 'the single iframe fills the stage at ' + width);
    if (width > 900) assert.ok(metrics.panel.x >= metrics.screen.right, 'panel is beside the player at ' + width);
    else assert.ok(metrics.panel.y >= metrics.screen.bottom, 'panel stacks below the player at ' + width);
    assert.equal(await page.locator('#resync-button').isVisible(), true);
    assert.equal(await page.locator('#copy-invite').isVisible(), true);
    assert.equal(await page.locator('#chat-input').isVisible(), true);
    if (width <= 600) {
      const inputSize = await page.locator('#chat-input').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
      assert.ok(inputSize >= 16, 'mobile chat input avoids automatic zoom at ' + width);
    }
    await page.locator('#party-player').focus();
    const playerFocus = await page.locator('#screen').evaluate(element => {
      const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.notEqual(playerFocus.style, 'none', 'player focus is visible outside its clipped frame at ' + width);
    assert.ok(playerFocus.width >= 2, 'player focus has a clear outline at ' + width);
    assert.deepEqual(external, [], 'no real services contacted at ' + width);
    assert.deepEqual(errors, [], 'no page errors at ' + width);
    await context.close();
  }
  console.log('PASS: responsive party layout, existing keyboard controls and local-only room presentation.');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
