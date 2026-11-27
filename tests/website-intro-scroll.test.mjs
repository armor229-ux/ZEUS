// Run with: node --test tests/website-intro-scroll.test.mjs
// These focused tests exercise the real inline and shared intro code without
// requiring browser dependencies; browser input/paint checks are separate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');
const key = 'zeus_intro_seen_v1';
const apiSource = read('api.js');
const introSource = apiSource.slice(
  apiSource.indexOf('// Shared by the generic entrance'),
  apiSource.indexOf('/** Floating electric dust field')
);
const watchSource = read('watch.js');
const cineSource = watchSource.slice(
  watchSource.indexOf('function playCineEntrance()'),
  watchSource.indexOf('/* ============================================================\n   TITLE INFO')
);

function storage({ values = {}, blockRead = false, blockWrite = false, ignoreWrite = false } = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(name) {
      if (blockRead) throw new Error('storage read blocked');
      return data.has(name) ? data.get(name) : null;
    },
    setItem(name, value) {
      if (blockWrite) throw new Error('storage write blocked');
      if (!ignoreWrite) data.set(name, String(value));
    },
    removeItem(name) {
      if (blockWrite) throw new Error('storage write blocked');
      if (!ignoreWrite) data.delete(name);
    }
  };
}

function classes() {
  const set = new Set();
  return {
    add(...names) { names.forEach((name) => set.add(name)); },
    remove(...names) { names.forEach((name) => set.delete(name)); },
    contains(name) { return set.has(name); }
  };
}

function element() {
  const handlers = new Map();
  return {
    classList: classes(),
    style: {},
    removed: false,
    addEventListener(type, listener) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      handlers.set(type, (handlers.get(type) || []).filter((item) => item !== listener));
    },
    emit(type, event = {}) {
      (handlers.get(type) || []).slice().forEach((listener) => listener(event));
    },
    remove() { this.removed = true; }
  };
}

function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    }
  };
}

function earlyScript(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((script) => script.includes(key));
}

function runEarly(script, local, session, document) {
  vm.runInNewContext(script, { localStorage: local, sessionStorage: session, document });
}

function introEnvironment({ local = storage(), session = storage(), cine = false, reduced = false } = {}) {
  const timer = clock();
  const loader = element();
  const name = element();
  name.getAnimations = () => [];
  loader.querySelector = (selector) => selector === '.loader-name' ? name : null;
  const overlay = cine ? element() : null;
  const shell = cine ? element() : null;
  const body = element();
  const documentElement = element();
  const elements = { 'page-loader': loader, 'cine-overlay': overlay, 'player-shell': shell };
  const document = {
    body,
    documentElement,
    getElementById(id) {
      const found = elements[id];
      return found && !found.removed ? found : null;
    }
  };
  const listeners = new Map();
  const window = {
    localStorage: local,
    sessionStorage: session,
    matchMedia: () => ({ matches: reduced }),
    setTimeout: timer.setTimeout,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    emit(type, event) { (listeners.get(type) || []).forEach((listener) => listener(event)); }
  };
  const sandbox = {
    document,
    window,
    $: (selector) => document.getElementById(selector.slice(1)),
    setTimeout: timer.setTimeout,
    spawnLoaderParticles: () => {},
    injectSkyBolt: () => {}
  };
  vm.runInNewContext(introSource + '\n' + cineSource + `
    globalThis.intro = { initPageLoader, hasSeenIntro, markIntroSeen,
      playCineEntrance, hideCineOverlay };
  `, sandbox);
  return { intro: sandbox.intro, local, session, timer, loader, name, overlay, shell, body, documentElement, document, window };
}

test('all intro pages perform the same fail-open check before the body', () => {
  const files = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));
  let expected;
  let count = 0;
  for (const file of files) {
    const html = read(file);
    if (!html.includes('id="page-loader"')) continue; // Party has no intro.
    const script = earlyScript(html);
    assert.ok(script, `${file} is missing the early intro check`);
    assert.ok(html.indexOf(script) < html.indexOf('</head>'), `${file} checks too late`);
    if (expected === undefined) expected = script;
    assert.equal(script, expected, `${file} differs from the shared check`);
    count++;

    for (const [local, session, shouldSkip] of [
      [storage(), storage(), false],
      [storage({ values: { [key]: '1' } }), storage(), true],
      [storage({ blockRead: true }), storage({ values: { [key]: '1' } }), true],
      [storage({ blockWrite: true }), storage(), false],
      [storage({ ignoreWrite: true }), storage(), false],
      [storage({ blockWrite: true }), storage({ blockWrite: true }), true],
      [storage({ ignoreWrite: true }), storage({ ignoreWrite: true }), true],
      [storage({ blockRead: true }), storage({ blockRead: true }), true]
    ]) {
      const document = { documentElement: element() };
      runEarly(script, local, session, document);
      assert.equal(document.documentElement.classList.contains('no-page-loader'), shouldSkip, file);
    }
  }
  assert.equal(count, 15);
});

test('first generic intro records its start and plays until the reveal ends', () => {
  const env = introEnvironment();
  env.intro.initPageLoader();
  assert.equal(env.local.getItem(key), '1');
  assert.ok(env.loader.classList.contains('pr-go'));
  assert.ok(env.body.classList.contains('cine-hold'));
  env.name.emit('animationend', { animationName: 'another-animation' });
  assert.equal(env.body.classList.contains('cine-hold'), true);
  env.name.emit('animationend', { animationName: 'name-reveal' });
  assert.ok(env.loader.classList.contains('hidden'));
  assert.equal(env.body.classList.contains('cine-hold'), false);
  env.timer.tick(1100);
  assert.ok(env.loader.removed);
});

test('clicking or the existing safety timeout dismisses the generic intro', () => {
  for (const action of ['click', 'timeout']) {
    const env = introEnvironment();
    env.intro.initPageLoader();
    if (action === 'click') env.loader.emit('click');
    else env.timer.tick(6000);
    assert.equal(env.local.getItem(key), '1', action);
    assert.equal(env.body.classList.contains('cine-hold'), false, action);
  }
});

test('watch owns the first entrance, records its start, and invalid URLs cannot trap the generic loader', () => {
  const env = introEnvironment({ cine: true });
  env.intro.initPageLoader();
  assert.ok(env.loader.removed);
  assert.equal(env.local.getItem(key), null);
  env.intro.playCineEntrance();
  assert.ok(env.overlay.classList.contains('cine-playing'));
  assert.equal(env.local.getItem(key), '1');
  env.timer.tick(1350);
  assert.equal(env.local.getItem(key), '1');
  assert.ok(env.overlay.classList.contains('cine-out'));
  env.timer.tick(500);
  assert.equal(env.overlay.style.display, 'none');

  const invalid = introEnvironment({ cine: true });
  invalid.intro.initPageLoader();
  invalid.intro.hideCineOverlay(true);
  assert.ok(invalid.loader.removed);
  assert.equal(invalid.overlay.style.display, 'none');
  assert.equal(invalid.local.getItem(key), null);
});

test('watch click skips and returning visitors skip both overlays', () => {
  const first = introEnvironment({ cine: true });
  first.intro.initPageLoader();
  first.intro.playCineEntrance();
  first.overlay.emit('click');
  assert.ok(first.overlay.classList.contains('cine-out'));
  assert.equal(first.local.getItem(key), '1');

  const returning = introEnvironment({ cine: true, local: first.local });
  returning.intro.initPageLoader();
  returning.intro.playCineEntrance();
  assert.ok(returning.loader.removed);
  assert.equal(returning.overlay.style.display, 'none');
  assert.equal(returning.shell.classList.contains('shell-enter'), false);
});

test('refreshing or navigating during either first entrance never replays it', () => {
  for (const cine of [false, true]) {
    const first = introEnvironment({ cine });
    first.intro.initPageLoader();
    if (cine) first.intro.playCineEntrance();
    assert.equal(first.local.getItem(key), '1'); // animation still playing
    assert.equal(cine ? first.overlay.classList.contains('cine-done') : first.loader.removed, false);

    const next = introEnvironment({ cine, local: first.local });
    runEarly(earlyScript(read(cine ? 'watch.html' : 'privacy.html')), next.local, next.session, next.document);
    assert.ok(next.documentElement.classList.contains('no-page-loader'));
    next.intro.initPageLoader();
    if (cine) next.intro.playCineEntrance();
    assert.ok(next.loader.removed);
    assert.equal(next.body.classList.contains('cine-hold'), false);
    if (cine) assert.equal(next.overlay.style.display, 'none');
  }
});

test('reduced motion hides both entrances before scripts and never starts either animation', () => {
  assert.match(read('style.css'), /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.page-loader,\s*\.cine-overlay\s*\{\s*display:\s*none\s*!important/);
  for (const cine of [false, true]) {
    const env = introEnvironment({ cine, reduced: true });
    env.intro.initPageLoader();
    if (cine) env.intro.playCineEntrance();
    assert.equal(env.local.getItem(key), '1');
    assert.ok(env.loader.removed);
    assert.equal(env.body.classList.contains('cine-hold'), false);
    if (cine) assert.equal(env.overlay.style.display, 'none');
  }
});

test('blocked persistent writes fall back to session, and fully blocked storage fails open', () => {
  const local = storage({ blockRead: true, blockWrite: true });
  const session = storage();
  const env = introEnvironment({ local, session });
  env.intro.initPageLoader();
  assert.equal(session.getItem(key), '1');
  env.loader.emit('click');
  assert.ok(env.intro.hasSeenIntro());

  // A storage object may accept writes but refuse reads, or silently drop
  // writes. Verify the marker before relying on it instead of the fallback.
  for (const unusableLocal of [storage({ blockRead: true }), storage({ ignoreWrite: true })]) {
    const fallback = storage();
    const current = introEnvironment({ local: unusableLocal, session: fallback });
    current.intro.initPageLoader();
    assert.equal(fallback.getItem(key), '1');
  }

  // If write access disappears after the early check, dismissing the
  // entrance must still release the page even though it cannot be saved.
  const writesDenied = introEnvironment({
    local: storage({ blockWrite: true }),
    session: storage({ blockWrite: true })
  });
  writesDenied.intro.initPageLoader();
  assert.doesNotThrow(() => writesDenied.loader.emit('click'));
  assert.equal(writesDenied.body.classList.contains('cine-hold'), false);
  writesDenied.timer.tick(1100);
  assert.ok(writesDenied.loader.removed);

  // When storage comes back during the entrance, dismissal retries saving.
  for (const cine of [false, true]) {
    let denied = true;
    const data = storage();
    const intermittent = {
      getItem: data.getItem,
      setItem(name, value) {
        if (denied) throw new Error('storage temporarily unavailable');
        data.setItem(name, value);
      }
    };
    const recovery = introEnvironment({ local: intermittent, session: storage({ blockWrite: true }), cine });
    recovery.intro.initPageLoader();
    if (cine) recovery.intro.playCineEntrance();
    assert.equal(data.getItem(key), null);
    denied = false;
    if (cine) recovery.overlay.emit('click');
    else recovery.loader.emit('click');
    assert.equal(data.getItem(key), '1');
  }

  const bothBlocked = introEnvironment({
    local: storage({ blockRead: true, blockWrite: true }),
    session: storage({ blockRead: true, blockWrite: true }),
    cine: true
  });
  runEarly(earlyScript(read('watch.html')), bothBlocked.local, bothBlocked.session, bothBlocked.document);
  bothBlocked.intro.initPageLoader();
  bothBlocked.intro.playCineEntrance();
  assert.ok(bothBlocked.loader.removed);
  assert.equal(bothBlocked.overlay.style.display, 'none');
  assert.doesNotThrow(() => bothBlocked.intro.markIntroSeen());
});

test('subtitle preferences use page memory when storage is unavailable', () => {
  function boot(local) {
    const css = {};
    const document = {
      documentElement: { style: { setProperty(name, value) { css[name] = value; } } },
      querySelectorAll: () => []
    };
    const window = { addEventListener() {} };
    const sandbox = {
      window, document, localStorage: local,
      MutationObserver: class { observe() {} },
      requestAnimationFrame() {}
    };
    vm.runInNewContext(read('subtitle-prefs.js'), sandbox);
    return { prefs: window.ZEUS.subtitles, css };
  }

  const keys = { color: 'zeus_sub_color', offset: 'zeus_sub_offset_ms', pref: 'zeus_sub_pref' };
  const initial = { [keys.color]: '#abcdef', [keys.offset]: '-500', [keys.pref]: 'AR' };
  const normal = storage({ values: initial });
  const persistent = boot(normal);
  assert.equal(persistent.prefs.getColor(), '#abcdef');
  assert.equal(persistent.prefs.getOffset(), -500);
  assert.equal(persistent.prefs.getPref(), 'ar');
  persistent.prefs.saveColor('#123456');
  persistent.prefs.saveOffset(1200);
  persistent.prefs.savePref('TR');
  assert.equal(normal.getItem(keys.color), '#123456');
  assert.equal(normal.getItem(keys.offset), '1200');
  assert.equal(normal.getItem(keys.pref), 'tr');

  for (const local of [
    storage({ blockRead: true, blockWrite: true }),
    storage({ values: initial, blockWrite: true }),
    storage({ values: initial, ignoreWrite: true }),
    storage({ blockRead: true })
  ]) {
    const { prefs, css } = boot(local);
    assert.doesNotThrow(() => {
      prefs.saveColor('#fedcba');
      prefs.saveOffset(750);
      prefs.savePref('EN');
      prefs.setAnimeMode(true);
    });
    assert.equal(prefs.getColor(), '#fedcba');
    assert.equal(prefs.getOffset(), 750);
    assert.equal(prefs.getPref(), 'en');
    assert.equal(css['--zeus-sub-color'], '#fedcba');
  }
});

test('history restoration and cross-tab seen markers release an interrupted intro', () => {
  for (const eventType of ['pageshow', 'storage']) {
    for (const cine of [false, true]) {
      const env = introEnvironment({ cine });
      env.intro.initPageLoader();
      if (cine) env.intro.playCineEntrance();
      env.local.setItem(key, '1');
      env.window.emit(eventType, eventType === 'pageshow'
        ? { persisted: true }
        : { key, newValue: '1' });
      assert.ok(env.documentElement.classList.contains('no-page-loader'));
      assert.ok(env.loader.removed);
      assert.equal(env.body.classList.contains('cine-hold'), false);
      if (cine) {
        assert.ok(env.overlay.classList.contains('cine-done'));
        assert.equal(env.overlay.style.display, 'none');
      }
    }
  }
});

test('hover ambience and trailers wait for fast scrolling but remain immediate at rest', () => {
  const hoverSource = apiSource.slice(
    apiSource.indexOf('/** Mouse arrived on a new card'),
    apiSource.indexOf('/** Ken Burns fallback')
  );
  const timer = clock();
  const state = { card: null, dwellTimer: null };
  const card = { isConnected: true };
  const item = { id: 1 };
  let fast = true;
  let paints = 0;
  let previews = 0;
  const sandbox = {
    hoverTrailerState: state,
    cardItemData: new WeakMap([[card, item]]),
    ambientBackdrop: { show: () => { paints++; } },
    document: { body: { hasAttribute: () => fast } },
    endCardHover: () => { timer.clearTimeout(state.dwellTimer); state.card = null; },
    setTimeout: timer.setTimeout,
    CARD_TRAILER_DELAY_MS: 400,
    CARD_HOVER_GRACE_MS: 160,
    applyCardKenBurns: () => { previews++; },
    getMediaType: () => 'movie',
    trailerCacheKey: () => 'movie:1',
    cardTrailerEmbedFailed: { has: () => true }
  };
  vm.runInNewContext(hoverSource + '\nglobalThis.startHover = startCardHover;', sandbox);
  sandbox.startHover(card);
  assert.equal(paints, 0);
  timer.tick(400);
  assert.equal(paints, 0);
  assert.equal(previews, 0);
  fast = false;
  timer.tick(160);
  assert.equal(paints, 1);
  assert.equal(previews, 1);
  sandbox.startHover(card);
  assert.equal(paints, 2); // No delay for an ordinary hover at rest.
});

test('a trailer lookup finishing during fast scrolling waits for rest or cancels on leave', async () => {
  const hoverSource = apiSource.slice(
    apiSource.indexOf('/** Mouse arrived on a new card'),
    apiSource.indexOf('/** Ken Burns fallback')
  );
  const timer = clock();
  const state = { card: null, dwellTimer: null };
  const card = { isConnected: true };
  const item = { id: 1 };
  let fast = false;
  let mounts = 0;
  let resolveTrailer;
  const sandbox = {
    hoverTrailerState: state,
    cardItemData: new WeakMap([[card, item]]),
    ambientBackdrop: { show() {} },
    document: { body: { hasAttribute: () => fast } },
    endCardHover() { timer.clearTimeout(state.dwellTimer); state.card = null; },
    setTimeout: timer.setTimeout,
    CARD_TRAILER_DELAY_MS: 400,
    CARD_HOVER_GRACE_MS: 160,
    applyCardKenBurns() {},
    getMediaType: () => 'movie',
    trailerCacheKey: () => 'movie:1',
    cardTrailerEmbedFailed: { has: () => false },
    getTrailerKey: () => new Promise((resolve) => { resolveTrailer = resolve; }),
    playCardTrailer: () => { mounts++; }
  };
  vm.runInNewContext(hoverSource + '\nglobalThis.startHover = startCardHover;', sandbox);
  sandbox.startHover(card);
  timer.tick(400);
  fast = true;
  resolveTrailer('example');
  await Promise.resolve();
  timer.tick(160);
  assert.equal(mounts, 0);
  fast = false;
  timer.tick(160);
  assert.equal(mounts, 1);

  sandbox.startHover(card);
  timer.tick(400);
  fast = true;
  resolveTrailer('example');
  await Promise.resolve();
  sandbox.endCardHover();
  fast = false;
  timer.tick(160);
  assert.equal(mounts, 1); // a departed card cannot start a trailer
});

test('fast scrolling is passive and does not repeatedly restyle or suppress all pointer events', () => {
  const source = read('header-autohide.js');
  const start = source.indexOf('   3. SCROLL VELOCITY');
  const end = source.indexOf('   3b. BANNER SAFE TOP', start);
  const scrollSource = source.slice(source.lastIndexOf('/*', start), source.lastIndexOf('/*', end));
  assert.ok(scrollSource.includes('FAST_PX_PER_FRAME'));
  assert.doesNotMatch(read('style.css'), /body\[data-scrolling\s*=\s*["']?1["']?\]\s+\*/);

  const timer = clock();
  const listeners = new Map();
  const rafs = [];
  const writes = [];
  const body = {
    setAttribute(name, value) { writes.push([name, value]); },
    removeAttribute(name) { writes.push([name, null]); }
  };
  const window = {
    scrollY: 0,
    addEventListener(type, listener, options) { listeners.set(type, { listener, options }); },
    requestAnimationFrame(callback) { rafs.push(callback); }
  };
  vm.runInNewContext(scrollSource, {
    window,
    document: { body },
    performance: { now: () => 1000 },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout
  });
  assert.deepEqual([...listeners.keys()], ['scroll']);
  assert.equal(listeners.get('scroll').options.passive, true);

  for (const [y, timestamp] of [[120, 1016], [125, 1032], [205, 1048]]) {
    window.scrollY = y;
    listeners.get('scroll').listener();
    assert.equal(rafs.length, 1);
    rafs.shift()(timestamp);
  }
  assert.deepEqual(writes, [['data-scroll-fast', '1']]);
  timer.tick(120);
  window.scrollY = 210;
  listeners.get('scroll').listener();
  timer.tick(30); // A delayed frame must not let the old idle timer fire.
  assert.deepEqual(writes, [['data-scroll-fast', '1']]);
  rafs.shift()(1064);
  timer.tick(140);
  assert.deepEqual(writes, [['data-scroll-fast', '1'], ['data-scroll-fast', null]]);
});

test('native scrollend holds the fast guard during a drag and releases it only for the document', () => {
  const source = read('header-autohide.js');
  const start = source.indexOf('   3. SCROLL VELOCITY');
  const end = source.indexOf('   3b. BANNER SAFE TOP', start);
  const scrollSource = source.slice(source.lastIndexOf('/*', start), source.lastIndexOf('/*', end));
  const timer = clock();
  const rafs = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const writes = [];
  const body = {
    setAttribute(name, value) { writes.push([name, value]); },
    removeAttribute(name) { writes.push([name, null]); }
  };
  const document = {
    body,
    onscrollend: null,
    addEventListener(type, listener, options) { documentListeners.set(type, { listener, options }); }
  };
  const window = {
    scrollY: 0,
    addEventListener(type, listener, options) { windowListeners.set(type, { listener, options }); },
    requestAnimationFrame(callback) { rafs.push(callback); }
  };
  vm.runInNewContext(scrollSource, {
    window, document, performance: { now: () => 1000 },
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout
  });
  assert.equal(windowListeners.get('scroll').options.passive, true);
  assert.equal(documentListeners.get('scrollend').options.passive, true);
  const scroll = windowListeners.get('scroll').listener;
  const scrollend = documentListeners.get('scrollend').listener;

  window.scrollY = 150;
  scroll();
  rafs.shift()(1016);
  assert.deepEqual(writes, [['data-scroll-fast', '1']]);
  timer.tick(400); // A held thumb can have long gaps between scroll events.
  scrollend({ target: {} }); // Nested horizontal carousel must not end the document gesture.
  timer.tick(400);
  assert.deepEqual(writes, [['data-scroll-fast', '1']]);
  scrollend({ target: document });
  timer.tick(139);
  assert.deepEqual(writes, [['data-scroll-fast', '1']]);
  timer.tick(1);
  assert.deepEqual(writes, [['data-scroll-fast', '1'], ['data-scroll-fast', null]]);

  // The end event can precede the rAF that notices the final scroll.
  window.scrollY = 400;
  scroll();
  scrollend({ target: document });
  timer.tick(140);
  assert.equal(rafs.length, 1);
  rafs.shift()(1032);
  assert.deepEqual(writes.at(-1), ['data-scroll-fast', '1']);
  timer.tick(100);
  window.scrollY = 405;
  scroll(); // A new gesture cancels the scheduled release immediately.
  timer.tick(100);
  assert.deepEqual(writes.at(-1), ['data-scroll-fast', '1']);
  rafs.shift()(1048);
  scrollend({ target: document });
  timer.tick(140);
  assert.deepEqual(writes.at(-1), ['data-scroll-fast', null]);
  assert.equal(writes.length, 4);
});

function bannerEnvironment({ resizeObserver = true } = {}) {
  const source = read('header-autohide.js');
  const start = source.indexOf('   3b. BANNER SAFE TOP');
  const end = source.indexOf('   4. PAGE CROSS-FADE', start);
  const bannerSource = source.slice(source.lastIndexOf('/*', start), source.lastIndexOf('/*', end));
  const rafs = [];
  const mutations = [];
  const resizes = [];
  const windowListeners = new Map();
  const fontListeners = new Map();
  let fontReady;
  const writes = [];

  class Node {
    constructor({ candidate = false, height = 0, top = 0 } = {}) {
      this.nodeType = 1;
      this.candidate = candidate;
      this.rect = { height, top };
      this.children = [];
      this.parent = null;
      this.reads = 0;
    }
    append(child) { child.parent = this; this.children.push(child); }
    remove(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
    matches() { return this.candidate; }
    contains(other) {
      for (let node = other; node; node = node.parent) if (node === this) return true;
      return false;
    }
    querySelector() {
      for (const child of this.children) {
        if (child.candidate) return child;
        const nested = child.querySelector();
        if (nested) return nested;
      }
      return null;
    }
    getBoundingClientRect() { this.reads++; return this.rect; }
  }
  const body = new Node();
  const banner = new Node({ candidate: true });
  const poster = new Node();
  body.append(banner);
  body.append(poster);
  const values = new Map();
  const style = {
    getPropertyValue(name) { return values.get(name) || ''; },
    setProperty(name, value) { values.set(name, value); writes.push([name, value]); }
  };
  const document = {
    body,
    documentElement: { style },
    fonts: {
      addEventListener(type, listener) { fontListeners.set(type, listener); },
      ready: { then(listener) { fontReady = listener; } }
    },
    querySelectorAll() {
      const out = [];
      function visit(node) {
        if (node.candidate) out.push(node);
        node.children.forEach(visit);
      }
      visit(body);
      return out;
    }
  };
  const window = {
    requestAnimationFrame(callback) { rafs.push(callback); },
    addEventListener(type, callback, options) { windowListeners.set(type, { callback, options }); }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); resizes.push(this); }
    observe(node) { this.observed.add(node); }
    unobserve(node) { this.observed.delete(node); }
  }
  vm.runInNewContext(bannerSource, {
    document, window, MutationObserver, ResizeObserver: resizeObserver ? ResizeObserver : undefined
  });
  return {
    Node, body, banner, poster, values, writes, rafs, mutations, resizes, windowListeners, fontListeners,
    fontsReady() { if (fontReady) fontReady(); },
    flush() { while (rafs.length) rafs.shift()(); }
  };
}

test('banner measurement ignores card churn but coalesces visibility, resize and dynamic banner updates', () => {
  const env = bannerEnvironment();
  const { Node, body, banner, poster, values, writes, rafs, mutations, resizes } = env;
  const observer = mutations[0];
  const resize = resizes[0];
  assert.equal(observer.target, body);
  assert.equal(observer.options.subtree, true);
  assert.equal(values.get('--zeus-safe-top'), '0px');
  assert.ok(resize.observed.has(banner));
  assert.equal(env.fontListeners.size, 0); // ResizeObserver already covers font reflow.

  banner.rect.height = 52;
  observer.callback([
    { type: 'attributes', target: banner, attributeName: 'hidden' },
    { type: 'attributes', target: body, attributeName: 'class' }
  ]);
  resize.callback();
  assert.equal(rafs.length, 1);
  env.flush();
  assert.equal(values.get('--zeus-safe-top'), '52px');
  const reads = banner.reads;
  const count = writes.length;
  for (let i = 0; i < 100; i++) {
    observer.callback([
      { type: 'attributes', target: poster, attributeName: 'class' },
      { type: 'attributes', target: body, attributeName: 'data-scrolled' },
      { type: 'attributes', target: body, attributeName: 'data-scroll-fast' },
      { type: 'childList', target: poster, addedNodes: [new Node()], removedNodes: [] }
    ]);
  }
  assert.equal(rafs.length, 0);
  assert.equal(banner.reads, reads);
  assert.equal(writes.length, count);

  banner.rect.height = 78;
  resize.callback();
  resize.callback();
  assert.equal(rafs.length, 1);
  env.flush();
  assert.equal(values.get('--zeus-safe-top'), '78px');
  const unchangedWrites = writes.length;
  observer.callback([{ type: 'attributes', target: banner, attributeName: 'style' }]);
  env.flush();
  assert.equal(writes.length, unchangedWrites); // unchanged height is not rewritten

  banner.rect.height = 0;
  observer.callback([{ type: 'attributes', target: banner, attributeName: 'hidden' }]);
  env.flush();
  assert.equal(values.get('--zeus-safe-top'), '0px');

  const wrapper = new Node();
  const injected = new Node({ candidate: true, height: 36 });
  wrapper.append(injected);
  body.append(wrapper);
  observer.callback([{ type: 'childList', target: body, addedNodes: [wrapper], removedNodes: [] }]);
  env.flush();
  assert.equal(values.get('--zeus-safe-top'), '36px');
  assert.ok(resize.observed.has(injected));
  injected.rect.top = 12; // an ancestor can move the banner below the viewport top
  observer.callback([{ type: 'attributes', target: wrapper, attributeName: 'class' }]);
  env.flush();
  assert.equal(values.get('--zeus-safe-top'), '0px');
  body.remove(wrapper);
  observer.callback([{ type: 'childList', target: body, addedNodes: [], removedNodes: [wrapper] }]);
  env.flush();
  assert.equal(resize.observed.has(injected), false);
});

test('banner measurement still follows mutations and resize without ResizeObserver', () => {
  const env = bannerEnvironment({ resizeObserver: false });
  const observer = env.mutations[0];
  env.banner.rect.height = 64;
  observer.callback([{ type: 'attributes', target: env.banner, attributeName: 'hidden' }]);
  env.flush();
  assert.equal(env.values.get('--zeus-safe-top'), '64px');
  env.banner.rect.height = 92;
  assert.equal(env.windowListeners.get('resize').options.passive, true);
  env.windowListeners.get('resize').callback();
  env.flush();
  assert.equal(env.values.get('--zeus-safe-top'), '92px');
  env.banner.rect.height = 100;
  env.fontListeners.get('loadingdone')();
  env.fontsReady();
  assert.equal(env.rafs.length, 1); // both font signals share one measurement
  env.flush();
  assert.equal(env.values.get('--zeus-safe-top'), '100px');
});

test('shared banner observer and responsive intrinsic-size fallback load on every intro page', () => {
  const pages = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));
  let count = 0;
  const headerVersions = new Set();
  const styleVersions = new Set();
  for (const page of pages) {
    const html = read(page);
    if (!html.includes('id="page-loader"')) continue;
    const header = html.match(/header-autohide\.js\?v=([\d.]+)/);
    const style = html.match(/style\.css\?v=([\d.]+)/);
    assert.ok(header, `${page} is missing the shared header script`);
    assert.ok(style, `${page} is missing the versioned stylesheet`);
    headerVersions.add(header[1]);
    styleVersions.add(style[1]);
    assert.doesNotMatch(html, /new MutationObserver\(updateSafeTop\)/);
    count++;
  }
  assert.ok(count >= 15);
  assert.equal(headerVersions.size, 1);
  assert.equal(styleVersions.size, 1);
  const css = read('style.css');
  assert.match(css, /contain-intrinsic-size:\s*auto 348px/);
  assert.match(css, /@supports\s*\(container-type:\s*inline-size\)/);
  assert.match(css, /contain-intrinsic-block-size:\s*auto calc\(var\(--zeus-grid-column-width\)/);
});

test('container-query fallback track thresholds match the responsive grid', () => {
  const css = read('style.css');
  const start = css.indexOf('/* Browsers with container queries but not typed division');
  const end = css.indexOf('/* Genre tile grid', start);
  assert.ok(start > 0 && end > start);
  const fallback = css.slice(start, end);
  const [desktop, mobileAndSmall] = fallback.split('@media (max-width: 768px)');
  const [mobile, small] = mobileAndSmall.split('@media (max-width: 480px)');
  function thresholds(section) {
    return [...section.matchAll(/@container zeus-grid \(min-width: (\d+)px\)\s*\{\s*\.movies-grid > \.movie-card\s*\{\s*--zeus-grid-columns:\s*(\d+)/g)]
      .map((match) => [Number(match[1]), Number(match[2])]);
  }
  const expected = (min, gap, maxColumns) => Array.from(
    { length: maxColumns - 1 }, (_, index) => {
      const columns = index + 2;
      return [columns * min + (columns - 1) * gap, columns];
    }
  );
  assert.deepEqual(thresholds(desktop), expected(155, 24, 8));
  assert.deepEqual(thresholds(mobile), expected(138, 14, 5));
  assert.deepEqual(thresholds(small), expected(124, 12, 4));
});
