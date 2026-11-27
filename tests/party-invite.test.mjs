// Run with: node --test tests/party-invite.test.mjs
// Execute the real party client with a small DOM stub; browser security
// behavior is also checked separately in a real browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'public', 'party.js'), 'utf8');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.htmlWrites = [];
    this._text = '';
    this.value = '';
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(value) {
    this.htmlWrites.push(String(value));
    this._text = '';
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener() {}
}

function boot(search = '', pathname = '/party.html') {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    createElement(tagName) { return new Element(tagName); },
    createElementNS(_namespace, tagName) { return new Element(tagName); },
  };
  const location = new URL('https://zeus.example' + pathname + search);
  const window = {};
  vm.runInNewContext(source, {
    document,
    location,
    window,
    URL,
    URLSearchParams,
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() { return 1; },
    setInterval() { return 1; },
    clearTimeout() {},
    clearInterval() {},
  }, { filename: 'party.js', timeout: 1000 });
  return { nodes, state: window.ZEUSParty.state };
}

function queryFor(room) {
  const query = new URLSearchParams();
  query.set('room', room);
  return '?' + query.toString();
}

test('without a room, the join panel describes creating a new one', () => {
  for (const search of ['', '?room=', queryFor('   ')]) {
    const { nodes, state } = boot(search);
    const meta = nodes.get('join-meta');
    assert.equal(meta.textContent, 'A new room will be created for you.');
    assert.equal(meta.children.length, 0);
    assert.deepEqual(meta.htmlWrites, []);
    assert.equal(state.roomId, null);
  }
});

test('an ordinary invite retains the normalized code and strong styling', () => {
  const { nodes, state } = boot(queryFor('  a7b9q2  '));
  const meta = nodes.get('join-meta');
  assert.equal(state.roomId, 'A7B9Q2');
  assert.equal(meta.textContent, 'Joining room A7B9Q2');
  assert.equal(meta.children.length, 1);
  assert.equal(meta.children[0].tagName, 'STRONG');
  assert.equal(meta.children[0].textContent, 'A7B9Q2');
  assert.deepEqual(meta.htmlWrites, []);
  assert.equal(nodes.get('room-code-text').textContent, 'A7B9Q2');
  assert.equal(nodes.get('invite-code').textContent, 'A7B9Q2');
  assert.equal(new URL(nodes.get('invite-link').value).searchParams.get('room'), 'A7B9Q2');
});

test('markup and event-handler payloads remain literal room text', () => {
  const payloads = [
    '<img src=x onerror=&#97;&#108;&#101;&#114;&#116;(1)>',
    '</strong><svg onload=&#97;&#108;&#101;&#114;&#116;(1)>',
    '<script>not markup</script>',
    '&lt;strong&gt;encoded&lt;/strong&gt;',
  ];
  for (const payload of payloads) {
    const { nodes, state } = boot(queryFor(payload));
    const meta = nodes.get('join-meta');
    const expected = payload.trim().toUpperCase();
    assert.equal(state.roomId, expected);
    assert.equal(meta.textContent, 'Joining room ' + expected);
    assert.equal(meta.children.length, 1);
    assert.equal(meta.children[0].tagName, 'STRONG');
    assert.equal(meta.children[0].textContent, expected);
    assert.equal(meta.children[0].children.length, 0);
    assert.deepEqual(meta.htmlWrites, []);
    assert.deepEqual(meta.children[0].htmlWrites, []);
  }
});

test('invite links encode query delimiters and round-trip the original room value', () => {
  const room = 'AB&url=https://evil.example/#FRAGMENT?X=1';
  const { nodes, state } = boot(queryFor(room));
  const invite = new URL(nodes.get('invite-link').value);
  assert.equal(invite.origin, 'https://zeus.example');
  assert.equal(invite.pathname, '/party.html');
  assert.equal(invite.hash, '');
  assert.deepEqual([...invite.searchParams.keys()], ['room']);
  assert.equal(invite.searchParams.get('room'), state.roomId);
});

test('invites keep the clean party route when it is in use', () => {
  const { nodes } = boot(queryFor('r23456'), '/party');
  const invite = new URL(nodes.get('invite-link').value);
  assert.equal(invite.pathname, '/party');
  assert.equal(invite.searchParams.get('room'), 'R23456');
});
