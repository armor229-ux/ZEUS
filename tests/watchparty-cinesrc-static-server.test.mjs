// The optional local test server must not serve bundled video or proxy a service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('static user-test server serves the CineSrc page but refuses local video', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./watchparty-cinesrc-static-server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Static server did not start: ' + output)), 10000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('ZEUS static test site listening')) { clearTimeout(timeout); resolve(); }
      });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Static server exited: ' + code + ' ' + output)); });
    });
    const base = 'http://127.0.0.1:' + port;
    const party = await fetch(base + '/party.html');
    assert.equal(party.status, 200);
    const html = await party.text();
    assert.match(html, /watchparty-cinesrc\.js/);
    assert.doesNotMatch(html, /src="party\.js/);
    const watch = await (await fetch(base + '/watch.html?id=123&type=movie')).text();
    assert.match(watch, /watchparty-launch\.js/);
    assert.doesNotMatch(watch, /src="watchparty\.js/);
    assert.match(await (await fetch(base + '/watch?id=123&type=movie')).text(), /watchparty-launch\.js/);
    assert.match(await (await fetch(base + '/party')).text(), /watchparty-cinesrc\.js/);
    assert.equal((await fetch(base + '/discover')).status, 200);
    assert.equal((await fetch(base + '/media/watchparty-demo.mp4')).status, 404);
    assert.equal((await fetch(base + '/media/watchparty-demo.webm')).status, 404);
    assert.equal((await fetch(base + '/anything.mp4')).status, 404);
    for (const draft of ['direct-party.html', 'direct-party.js', 'party.js', 'watchparty.js', 'watchparty-player.js']) {
      assert.equal((await fetch(base + '/' + draft)).status, 404, 'preserved drafts are not served: ' + draft);
    }
    assert.equal((await fetch(base + '/__test_rpc', { method: 'POST' })).status, 405);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  }
});
