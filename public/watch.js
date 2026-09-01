/* ============================================================
   ZEUS - watch.js
   Premium video player page (1Tube / Netplayz "floating
   controls" style):
   - Cinematic entrance lighting on open (click skips)
   - Top chrome bar: back + title + runtime on the left; the
     🌐 Servers picker on the right.
   - Grouped server list in the Servers modal (Recommended /
     Reliable / Asian dramas) — nine sources defined in the
     SERVER_URLS map and authored statically in watch.html
     (#server-list). Active server = cyan border; the status
     dot + "Unstable" pill are injected by watch.js.
   - SERVER LOADING (loadServerInIframe): success = the iframe
     LOADS within the timeout (10s per try) — plain and simple.
     A load timeout records a real FAIL (red); a confirmed load
     records OK (green) and is saved as the user's default.
   - Engine health stats in localStorage (zeus_engine_stats_v2,
     ok/fail timestamp arrays capped at 10 per 24h), strict
     FAILED rule (confirmed events only), "Test servers" bulk
     checker (hidden-iframe load tests, 8s — HINTS ONLY in
     zeus_engine_hints_v1, a missed test NEVER fails a server),
     "Report server" button, status dots, "Hide failed" toggle,
     "Unstable" labels (confirmed evidence only) and a "Reset
     status" button that wipes stale health data.
   - AUTO (Source Checker, ON by default — zeus_auto_mode_v1):
     triggered ONLY by the "AUTO Best" button inside the
     Servers modal. autoSelectBestServer() simply tries every
     VISIBLE server in list order (no preflight filtering) and
     keeps the first one that loads; all-fail falls back to the
     first server (or AutoNext hops on TV). A dead server
     triggers the same pass automatically.
   - AutoNext Episode toggle (TV only, below the player): when
     ON, the next episode loads automatically when the video
     ends (postMessage from the source player) or when every
     source fails.
   - TV season / episode controls with prev/next navigation
   - Title info card + watchlist toggle below the player
   ============================================================ */

'use strict';

/* ---------------- Server URL map (the 9 sources) ----------------
   One builder per server: (id, season, episode, type) ->
   embed URL. Keys match the data-server attributes of the
   static #server-list markup in watch.html. */
const SERVER_URLS = {
  vidcore: (id, s, e, type) => type === 'tv' ? `https://vidcore.org/embed/tv/${id}/${s}/${e}` : `https://vidcore.org/embed/movie/${id}`,
  superembed: (id, s, e, type) => type === 'tv' ? `https://superembed.stream/tv/${id}/${s}-${e}` : `https://superembed.stream/movie/${id}`,
  vidlinkpro: (id, s, e, type) => type === 'tv' ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/movie/${id}`,
  embedlc: (id, s, e, type) => type === 'tv' ? `https://embed.lc/tv/${id}/${s}/${e}` : `https://embed.lc/movie/${id}`,
  autoembed: (id, s, e, type) => type === 'tv' ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : `https://autoembed.co/movie/tmdb/${id}`,
  vidsrcto: (id, s, e, type) => type === 'tv' ? `https://vidsrc.to/embed/tv/${id}/${s}/${e}` : `https://vidsrc.to/embed/movie/${id}`,
  vidsrccc: (id, s, e, type) => type === 'tv' ? `https://vidsrc.cc/embed/tv/${id}/${s}/${e}` : `https://vidsrc.cc/embed/movie/${id}`,
  '2embedcc': (id, s, e, type) => type === 'tv' ? `https://2embed.cc/embed/tv/${id}/${s}/${e}` : `https://2embed.cc/embed/movie/${id}`,
  nontongo: (id, s, e, type) => type === 'tv' ? `https://nontongo.win/embed/tv/${id}/${s}/${e}` : `https://nontongo.win/embed/movie/${id}`,
};

/* localStorage keys (independent of the watchlist storage) */
const SERVER_PREF_KEY = 'zeus_watch_server';   // { id } — last picked server

/* ---------------- Source Checker (server health) ----------------
   All health data is keyed by SERVER (serverKey = the
   data-server key of the SERVER_URLS map), never by label, so
   "Hide failed", the dots and the fallback rotation all act on
   real backend health.                                       */
const SERVER_STATS_KEY = 'zeus_engine_stats_v2';         // engineKey -> { ok, fail, lastOk, lastFail, okTimes[], failTimes[] }
const ENGINE_HINTS_KEY = 'zeus_engine_hints_v1';         // engineKey -> { lastPreflightOk, lastPreflightFail } — HINTS ONLY, never fail stats
const LAST_GOOD_SERVER_KEY = 'zeus_last_good_engine_v1'; // { movie|tv: engineKey }
const HIDE_FAILED_PREF_KEY = 'zeus_hide_failed_v1';
const AUTO_MODE_KEY = 'zeus_auto_mode_v1';                // "1" | "0" — AUTO (Source Checker) mode
const AUTO_NEXT_KEY = 'zeus_autonext_v1';                 // "1" | "0" — AutoNext Episode (TV only)
const DAY_MS = 24 * 60 * 60 * 1000; // recency window for stats
const RECENT_WINDOW_MS = 30 * 60 * 1000; // 30-minute window for instant-fail rule
const MAX_EVENT_TIMES = 10;          // cap for the ok/fail timestamp arrays

/* Session-level hard fails: servers that demonstrably broke
   during THIS browsing session. ONLY these events may add a
   hard fail: the iframe load TIMEOUT (loadServerInIframe gave
   up on the server) or the user clicking "Report server". A
   "Test servers" miss NEVER hard-fails a server. A hard fail
   hides the server instantly (with "Hide failed" ON) and a
   confirmed load success clears it. */
const SESSION_HARD_FAIL = new Set();

/* Server load timeouts: AUTO / manual loads wait up to 10s for
   the iframe 'load' event; "Test servers" probes wait 8s. */
const SERVER_LOAD_TIMEOUT_MS = 10000;
const SERVER_TEST_TIMEOUT_MS = 8000;

/* Test-server HINTS: "Test servers" probes (hidden-iframe
   load tests) persist their outcome in localStorage
   (zeus_engine_hints_v1 -> { serverKey: { lastPreflightOk,
   lastPreflightFail } }). A hint is ONLY a subtle signal — it
   NEVER writes health stats, NEVER marks a server FAILED and
   NEVER hides an item; it just adds a soft "maybe ok" halo to
   otherwise-unknown yellow dots. */
const engineHintMemory = {}; // session fallback when localStorage is blocked

function readEngineHints() {
  try {
    return JSON.parse(localStorage.getItem(ENGINE_HINTS_KEY)) || {};
  } catch (e) { return {}; }
}

/** Remember one preflight outcome as a HINT (PART 1).
 *  Success updates lastPreflightOk, a miss updates
 *  lastPreflightFail — but NOTHING is ever recorded as a FAIL
 *  stat and the engine is never added to SESSION_HARD_FAIL. */
function recordEngineHint(engine, ok) {
  const hints = readEngineHints();
  const entry = hints[engine]
    || engineHintMemory[engine]
    || { lastPreflightOk: 0, lastPreflightFail: 0 };
  if (ok) entry.lastPreflightOk = Date.now();
  else entry.lastPreflightFail = Date.now();
  hints[engine] = entry;
  engineHintMemory[engine] = entry; // session fallback
  try {
    localStorage.setItem(ENGINE_HINTS_KEY, JSON.stringify(hints));
  } catch (e) { /* storage blocked — memory hint only */ }
}

/** True when the engine's LATEST preflight hint (fresh within
 *  24h) was a SUCCESS. Sorting signal for AUTO only. */
function hasPreflightOkHint(engine) {
  const h = readEngineHints()[engine] || engineHintMemory[engine];
  if (!h || !h.lastPreflightOk) return false;
  if (Date.now() - h.lastPreflightOk >= DAY_MS) return false;
  return !h.lastPreflightFail || h.lastPreflightOk >= h.lastPreflightFail;
}

/* ---------------- State ---------------- */
let watchId = null;
let watchType = 'movie';          // 'movie' | 'tv'
let currentSeason = 1;
let currentEpisode = 1;
let activeServer = null;          // the server currently loaded / being loaded
let seasonsCache = [];            // seasons list for the show
let episodeCache = new Map();     // seasonNumber -> episodes[]
let infoLoaded = false;

/* Auto-fallback state */
let serverLoaded = false;         // has the current iframe confirmed a load?
let fallbacksUsed = 0;            // auto-switch cycles since the last manual pick
const MAX_AUTO_FALLBACKS = 4;     // guard: at most 4 automatic fallback cycles

/* Source Checker state */
let hideFailedServers = true;     // "Hide failed" toggle (default ON)
let switchGeneration = 0;        // guards async server picks against user clicks
let autoMode = true;             // AUTO (Source Checker) — ON by default (zeus_auto_mode_v1)
let autoSelectRunning = false;    // an autoSelectBestServer() pass is in flight
let autoSelectAbort = null;       // set while a pass runs — a user pick aborts it
let pendingPlayerLoad = null;     // in-flight player load — superseded by the next one
let testingServers = false;      // a "Test servers" probe run is in flight
let manualSourceCheck = false;   // manual server click -> "Checking sources…" overlay

/* AutoNext state (TV only) */
let autoNextEnabled = false;     // AutoNext Episode toggle (zeus_autonext_v1)
let autoNextFailHops = 0;        // consecutive failure-triggered hops (guard against loops)
let lastAutoNextAt = 0;          // cooldown between AutoNext advances
const AUTO_NEXT_MAX_FAIL_HOPS = 3;

document.addEventListener('DOMContentLoaded', async () => {
  initCommonUI();

  const id = getUrlParam('id');
  const type = getUrlParam('type');

  if (!id || !/^\d+$/.test(id)) {
    hideCineOverlay(true);
    showInvalidState($('#watch-container'), 'Missing or invalid video ID. Please open this page from a valid title link.');
    return;
  }

  watchId = id;
  watchType = type === 'tv' ? 'tv' : 'movie';

  if (watchType === 'tv') {
    // Accept both season/episode and s/e URL styles
    const season = parseInt(getUrlParam('season') || getUrlParam('s'), 10);
    const episode = parseInt(getUrlParam('episode') || getUrlParam('e'), 10);
    currentSeason = Number.isFinite(season) && season > 0 ? season : 1;
    currentEpisode = Number.isFinite(episode) && episode > 0 ? episode : 1;
  }

  restoreAutoMode();
  restoreAutoNext();
  initPlayerChrome();
  initServerList();
  playCineEntrance();

  loadWatchInfo();

  if (watchType === 'tv') {
    $('#episode-controls').hidden = false;
    const autonextBar = $('#autonext-bar');
    if (autonextBar) autonextBar.hidden = false; // AutoNext is TV-only
    loadSeasonControls();
  }

  // Default server selection. AUTO mode simply tries every
  // visible server in list order and keeps the first one that
  // LOADS (loadServerInIframe); with AUTO off (legacy
  // preference), the quiet smart pick runs instead (last good
  // → highest score → first server).
  const generation = switchGeneration;
  if (autoMode) {
    await autoSelectBestServer();
  } else {
    await initSmartServerSelection();
    if (generation === switchGeneration) {
      await setActiveServer(activeServer, false, 'initial');
    }
  }
});

/* ============================================================
   PLAYER CHROME (top bar — floating controls): back + title on
   the left; Quality 1080p / Audio & Subtitles popovers and the
   🌐 Servers picker on the right (AUTO lives in the Servers
   modal — "AUTO Best" is the only AUTO trigger)
   ============================================================ */
function initPlayerChrome() {
  // Back button
  const back = $('#chrome-back');
  if (back) {
    back.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.href = 'index.html';
    });
  }

  // Server picker modal
  const serversBtn = $('#servers-btn');
  if (serversBtn) serversBtn.addEventListener('click', openServerModal);
  const closeBtn = $('#server-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeServerModal);
  const backdrop = $('#server-modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeServerModal);

  // Source Checker: "Report server" button (modal header)
  const reportBtn = $('#report-server-btn');
  if (reportBtn) reportBtn.addEventListener('click', reportCurrentServer);

  // Source Checker: "Test servers" button (modal header, PART 5)
  const testBtn = $('#test-servers-btn');
  if (testBtn) testBtn.addEventListener('click', testServersForActiveTab);

  // Source Checker: "Reset status" button (modal header, PART 7).
  // Users upgrading from the old buggy health data (everything
  // UNSTABLE) start fresh: wipes the stored stats + preflight
  // hints, the session hard-fail set and the in-memory hint
  // cache, then repaints the dots.
  const resetBtn = $('#reset-server-stats-btn');
  if (resetBtn) resetBtn.addEventListener('click', resetServerStats);

  // AUTO Best (modal header) — the ONLY AUTO trigger on the
  // page. Force AUTO ON, close the modal and try every visible
  // server in list order until one loads.
  const autoModalBtn = $('#auto-modal-btn');
  if (autoModalBtn) {
    autoModalBtn.addEventListener('click', (e) => {
      e.preventDefault();
      autoMode = true;
      try {
        localStorage.setItem(AUTO_MODE_KEY, '1');
      } catch (storageError) { /* private mode — session only */ }
      autoSelectBestServer();
    });
  }

  // Source Checker: "Hide failed" toggle (modal header, default ON)
  const hideToggle = $('#hide-failed-toggle');
  if (hideToggle) {
    try {
      hideFailedServers = localStorage.getItem(HIDE_FAILED_PREF_KEY) !== '0';
    } catch (storageError) { /* private mode — keep default */ }
    hideToggle.setAttribute('aria-pressed', String(hideFailedServers));
    hideToggle.classList.toggle('on', hideFailedServers);
    hideToggle.addEventListener('click', () => {
      hideFailedServers = !hideFailedServers;
      try {
        localStorage.setItem(HIDE_FAILED_PREF_KEY, hideFailedServers ? '1' : '0');
      } catch (storageError) { /* ignore */ }
      hideToggle.setAttribute('aria-pressed', String(hideFailedServers));
      hideToggle.classList.toggle('on', hideFailedServers);
      updateServerDots();
    });
  }

  // Escape closes the modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeServerModal();
  });
}

/** Restore the AUTO (Source Checker) preference — default ON.
 *  The default is persisted on first load so the key always
 *  holds the current state ("1" | "0"). */
function restoreAutoMode() {
  try {
    const saved = localStorage.getItem(AUTO_MODE_KEY);
    if (saved === '0') {
      autoMode = false;
    } else {
      autoMode = true;
      if (saved !== '1') localStorage.setItem(AUTO_MODE_KEY, '1');
    }
  } catch (e) { /* storage blocked — keep default */ }
}

/* ---------------- AutoNext Episode (TASK 2.3, TV only) ----------------
   A toggle switch below the player. When ON:
   - the next episode loads automatically when the video ENDS
     (best-effort postMessage from the source player — VidLink
     and friends emit end events; origin-checked) —
   - and when every Premium source fails for the current
     episode (each server gets its 7s proof window; after the
     whole trial fails, AutoNext hops instead of giving up).
   Guarded: max 3 consecutive failure-triggered hops (reset by
   any confirmed playback or manual pick) + a 15s cooldown. */
function restoreAutoNext() {
  try {
    autoNextEnabled = localStorage.getItem(AUTO_NEXT_KEY) === '1';
  } catch (e) { /* storage blocked — keep default OFF */ }
  const input = $('#autonext-toggle-input');
  if (input) {
    input.checked = autoNextEnabled;
    input.addEventListener('change', () => {
      autoNextEnabled = input.checked;
      try {
        localStorage.setItem(AUTO_NEXT_KEY, autoNextEnabled ? '1' : '0');
      } catch (e) { /* storage blocked — session only */ }
      if (typeof showToast === 'function') {
        showToast(autoNextEnabled
          ? 'AutoNext on — next episode plays automatically'
          : 'AutoNext off', 'info');
      }
      console.log('[ZEUS] autoNextToggle', autoNextEnabled ? 'on' : 'off');
    });
  }
}

/** Advance to the next TV episode on the current Premium server.
 *  Returns true when a new episode actually started. */
async function autoNextAdvance(trigger) {
  if (!autoNextEnabled || watchType !== 'tv' || !watchId) return false;
  const failureHop = trigger !== 'video-ended';
  if (failureHop && autoNextFailHops >= AUTO_NEXT_MAX_FAIL_HOPS) return false;
  if (Date.now() - lastAutoNextAt < 15000) return false; // cooldown

  const episodes = await getEpisodes(currentSeason);
  const hasNextInSeason = episodes.some((e) => e.episode_number === currentEpisode + 1);
  if (hasNextInSeason) {
    currentEpisode += 1;
  } else {
    // roll over to the next season's first episode
    const nextSeason = seasonsCache.find((s) => s.season_number === currentSeason + 1);
    if (!nextSeason) return false; // last episode of the show
    currentSeason += 1;
    currentEpisode = 1;
    const seasonSelect = $('#watch-season-select');
    if (seasonSelect) seasonSelect.value = String(currentSeason);
    await refreshEpisodeSelect();
  }

  lastAutoNextAt = Date.now();
  if (failureHop) autoNextFailHops += 1;
  syncUrl();
  setActiveServer(activeServer, false, 'autonext');
  updateEpisodeNavButtons();
  loadWatchInfo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  console.log('[ZEUS] autoNext', { trigger, season: currentSeason, episode: currentEpisode });
  if (typeof showToast === 'function') {
    showToast(`AutoNext: playing S${currentSeason} E${currentEpisode}`, 'info');
  }
  return true;
}

/* Video-ended detection (best-effort, origin-checked): some
   Premium players (VidLink in particular) broadcast their
   playback state to the parent page via window.postMessage.
   A matching "ended"-like event triggers AutoNext. Foreign
   messages are ignored silently. */
window.addEventListener('message', (event) => {
  try {
    if (!autoNextEnabled || !serverLoaded) return;
    const frame = $('#player-frame');
    if (!frame || !frame.src) return;
    let frameOrigin = '';
    try { frameOrigin = new URL(frame.src).origin; } catch (e) { return; }
    if (event.origin !== frameOrigin) return; // not from our source
    let d = event.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = { type: d }; }
    }
    if (!d || typeof d !== 'object') return;
    const t = String(d.type || d.event || d.action || (d.data && d.data.type) || '')
      .toLowerCase().replace(/[^a-z]/g, '');
    if (t !== 'ended' && t !== 'videoend' && t !== 'playerended' && t !== 'end') return;
    console.log('[ZEUS] playerEvent', 'video-ended');
    autoNextAdvance('video-ended');
  } catch (e) { /* foreign message — ignore */ }
});

/* ============================================================
   SERVER PICKER MODAL (grouped server list)
   ============================================================ */
function openServerModal() {
  const modal = $('#server-modal');
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('server-modal-open');
  const closeBtn = $('#server-modal-close');
  if (closeBtn) closeBtn.focus();
}

function closeServerModal() {
  const modal = $('#server-modal');
  if (!modal || !modal.classList.contains('open')) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('server-modal-open');
}

/** Build the SERVER_LIST model from the static #server-list markup
 *  in watch.html (data-server / data-name), wire the click
 *  handlers, inject the status dot + "Unstable" pill (so the
 *  HTML stays clean) and restore the last picked server. */
const SERVER_LIST = []; // { id, name, el } — one entry per .server-item

function initServerList() {
  const list = $('#server-list');
  if (!list) return;
  list.querySelectorAll('.server-item').forEach((btn) => {
    const server = { id: btn.dataset.server, name: btn.dataset.name || btn.dataset.server, el: btn };
    if (!SERVER_URLS[server.id]) return; // unknown key — never wire it
    SERVER_LIST.push(server);
    // status dot + "Unstable" label are injected here so the
    // static HTML list stays exactly as authored
    const dot = document.createElement('span');
    dot.className = 'server-status-dot dot-unknown';
    dot.setAttribute('aria-hidden', 'true');
    btn.insertBefore(dot, btn.firstChild);
    const unstable = document.createElement('span');
    unstable.className = 'sc-unstable';
    unstable.hidden = true;
    unstable.textContent = 'Unstable';
    btn.appendChild(unstable);
    btn.addEventListener('click', () => {
      setActiveServer(server, false, 'manual');
      closeServerModal();
    });
  });
  if (!activeServer && SERVER_LIST.length) activeServer = SERVER_LIST[0];
  restoreServerPreference();
  highlightActiveServers();
  updateServerDots();
}

/** All servers, and the ones still visible ("Hide failed" ON
 *  hides confirmed-failed items — those are skipped by AUTO). */
function getServers() {
  return SERVER_LIST;
}

function getVisibleServers() {
  return SERVER_LIST.filter((s) => s.el && !s.el.classList.contains('server-item--hidden'));
}

function findServerById(id) {
  return SERVER_LIST.find((s) => s.id === id) || null;
}

/** Paint the active server item (cyan border). */
function highlightActiveServers() {
  $$('.server-item').forEach((el) => {
    const isActive = !!activeServer && el.dataset.server === activeServer.id;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-pressed', String(isActive));
  });
}

/** Restore the last selected server from localStorage. */
function restoreServerPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(SERVER_PREF_KEY) || 'null');
    if (!saved || !saved.id) return;
    const server = findServerById(saved.id);
    if (server) activeServer = server;
  } catch (e) { /* corrupt entry — keep the first server */ }
}

/* ============================================================
   SOURCE CHECKER — server health stats, tests, smart pick
   ============================================================ */

/** Read the whole health map: engineKey ->
 *  { ok, fail, lastOk, lastFail, okTimes[], failTimes[] }. */
function readServerStats() {
  try {
    return JSON.parse(localStorage.getItem(SERVER_STATS_KEY)) || {};
  } catch (e) { return {}; }
}

function getEngineStats(engine) {
  return readServerStats()[engine] || null;
}

/** Record a load success/failure for one ENGINE (PART 2A).
 *  Besides the ok/fail counters, every event pushes a timestamp
 *  into okTimes/failTimes (kept to the last 24h, capped at 10)
 *  so the strict FAILED rule can count events inside precise
 *  windows. A success also clears the session hard-fail flag;
 *  a failure sets it — and ONLY real events reach the failure
 *  branch (PART C2: watchdog timeout, iframe error, internal
 *  browser error page, user report; preflight misses never
 *  call this with false). */
function recordServerResult(engine, ok) {
  const stats = readServerStats();
  const entry = stats[engine]
    || { ok: 0, fail: 0, lastOk: 0, lastFail: 0, okTimes: [], failTimes: [] };
  const now = Date.now();
  // rolling 24h window: stale counters reset before the new event
  const lastActivity = Math.max(entry.lastOk || 0, entry.lastFail || 0);
  if (lastActivity && now - lastActivity >= DAY_MS) {
    entry.ok = 0;
    entry.fail = 0;
  }
  entry.okTimes = (entry.okTimes || []).filter((t) => now - t < DAY_MS);
  entry.failTimes = (entry.failTimes || []).filter((t) => now - t < DAY_MS);
  if (ok) {
    entry.ok = (entry.ok || 0) + 1;
    entry.lastOk = now;
    entry.okTimes.push(now);
    SESSION_HARD_FAIL.delete(engine); // any success revives the engine
  } else {
    entry.fail = (entry.fail || 0) + 1;
    entry.lastFail = now;
    entry.failTimes.push(now);
    SESSION_HARD_FAIL.add(engine); // instant hide for this session
  }
  // keep only the last 24h and at most the 10 most recent events
  entry.okTimes = entry.okTimes.slice(-MAX_EVENT_TIMES);
  entry.failTimes = entry.failTimes.slice(-MAX_EVENT_TIMES);
  stats[engine] = entry;
  try {
    localStorage.setItem(SERVER_STATS_KEY, JSON.stringify(stats));
  } catch (e) { /* storage blocked — session only */ }
  updateServerDots();
}

/** Score = (ok - fail) with a recency bonus/penalty (±2 within 24h). */
function engineScore(engine) {
  const s = getEngineStats(engine);
  if (!s) return 0;
  let score = (s.ok || 0) - (s.fail || 0);
  const now = Date.now();
  if (s.lastOk && now - s.lastOk < DAY_MS) score += 2;
  if (s.lastFail && now - s.lastFail < DAY_MS) score -= 2;
  return score;
}

/** RECENT OK (PART 2C): at least one success in the last 24h AND
 *  the latest success is not older than the latest failure. */
function isRecentlyOk(engine) {
  const s = getEngineStats(engine);
  if (!s) return false;
  const now = Date.now();
  const okTimes = (s.okTimes || []).filter((t) => now - t < DAY_MS);
  if (!okTimes.length) return false;
  return !s.lastFail || (s.lastOk || 0) >= s.lastFail;
}

/** STRICT FAILED rule (PARTS 2 + 3). An engine is FAILED when
 *  ANY of these holds — based on CONFIRMED fail events ONLY
 *  (watchdog timeout / iframe error / browser error page /
 *  user report; preflight misses never write failTimes and
 *  never enter SESSION_HARD_FAIL):
 *   1) failTimes has >= 2 events within the last 24h, OR
 *   2) failTimes has >= 1 event within the last 30 minutes AND
 *      okTimes has 0 events within the last 30 minutes, OR
 *   3) the engine is in the session hard-fail set. */
function isEngineFailed(engine) {
  if (SESSION_HARD_FAIL.has(engine)) return true;
  const s = getEngineStats(engine);
  if (!s) return false;
  const now = Date.now();
  const failTimes = (s.failTimes || []).filter((t) => now - t < DAY_MS);
  const okTimes = (s.okTimes || []).filter((t) => now - t < DAY_MS);
  // rule 1: repeated failures within 24h
  if (failTimes.length >= 2) return true;
  // rule 2: fresh failure with no fresh success (30-minute window)
  const recentFail = failTimes.some((t) => now - t < RECENT_WINDOW_MS);
  const recentOk = okTimes.some((t) => now - t < RECENT_WINDOW_MS);
  if (recentFail && !recentOk) return true;
  return false;
}

/** "Unstable" label rule (PART 3): show the label ONLY on
 *  confirmed evidence — RED (confirmed failed) OR at least one
 *  confirmed fail within 24h with ZERO confirmed OKs in 24h.
 *  A preflight hint alone NEVER triggers the label. */
function shouldShowUnstableLabel(engine) {
  if (isEngineFailed(engine)) return true;
  const s = getEngineStats(engine);
  if (!s) return false;
  const now = Date.now();
  const failTimes = (s.failTimes || []).filter((t) => now - t < DAY_MS);
  const okTimes = (s.okTimes || []).filter((t) => now - t < DAY_MS);
  return failTimes.length >= 1 && okTimes.length === 0;
}

/** Highest-scoring server that actually has stats (null when no
 *  data). FAILED servers are never candidates. */
function highestScoreServer(servers) {
  let best = null;
  let bestScore = 0;
  servers.forEach((server) => {
    if (isEngineFailed(server.id)) return;
    if (!getEngineStats(server.id)) return;
    const score = engineScore(server.id);
    if (!best || score > bestScore) {
      best = server;
      bestScore = score;
    }
  });
  return best;
}

/* ---- last-good-server memory (per media type) ---- */
function readLastGood() {
  try {
    return JSON.parse(localStorage.getItem(LAST_GOOD_SERVER_KEY)) || {};
  } catch (e) { return {}; }
}

function getLastGoodEngine(type) {
  const v = readLastGood()[type];
  return typeof v === 'string' ? v : null; // legacy nested shape -> fresh start
}

function setLastGoodEngine(type, engine) {
  const all = readLastGood();
  all[type] = engine;
  try {
    localStorage.setItem(LAST_GOOD_SERVER_KEY, JSON.stringify(all));
  } catch (e) { /* storage blocked — session only */ }
}

/** Build the embed URL for a server under the current title
 *  (SERVER_URLS: (id, season, episode, type) -> url). */
function buildServerUrl(server) {
  const builder = server && SERVER_URLS[server.id];
  if (!builder || !watchId) return null;
  return builder(watchId, currentSeason, currentEpisode, watchType);
}

/** Smart default server when the watch page opens and AUTO is
 *  off (legacy preference — AUTO is the default):
 *  1) last good server for this type — ONLY if not FAILED
 *  2) highest reliability score (score = ok - fail, with a
 *     recency bonus; FAILED servers skipped)
 *  3) if the current pick is FAILED, move to the first
 *     non-failed server
 *  4) current default (the first server in the list)
 *  A dead pick is handled by the load timeout + the AUTO
 *  fallback pass. */
async function initSmartServerSelection() {
  // (1) last good server — only when it is not failed
  const lastGood = getLastGoodEngine(watchType);
  if (lastGood) {
    const server = findServerById(lastGood);
    if (server && !isEngineFailed(server.id)) {
      activeServer = server;
    }
  }

  // (2) highest score (only switches when it actually beats the
  //     current pick — fresh users keep the default: the first
  //     server in the list)
  const best = highestScoreServer(SERVER_LIST);
  if (best && activeServer && best.id !== activeServer.id) {
    const currentScore = getEngineStats(activeServer.id)
      ? engineScore(activeServer.id)
      : 0;
    if (engineScore(best.id) > currentScore) activeServer = best;
  }

  // (3) never start on a FAILED server — take the first healthy one
  if (activeServer && isEngineFailed(activeServer.id)) {
    const healthy = SERVER_LIST.find((s) => !isEngineFailed(s.id));
    if (healthy) activeServer = healthy;
  }
}

/** Refresh the status dots + hide/dim state on every server
 *  item. Dots reflect CONFIRMED health only:
 *  - GREEN  = confirmed OK (a real load success within 24h) OR
 *             the currently active server whose iframe just
 *             loaded
 *  - RED    = confirmed FAIL (load timeout / user report)
 *  - YELLOW = unknown — servers whose latest "Test servers"
 *             hint was OK keep the YELLOW dot with a subtle
 *             "maybe ok" halo (data-preflight="ok"), never green
 *  "Unstable" label = confirmed failed OR >=1 confirmed fail
 *  in 24h with 0 OKs in 24h — NEVER from a test hint alone.
 *  Hide failed ON  -> only RED confirmed-failed items get
 *  display:none.
 *  Hide failed OFF -> failed items stay, dimmed (opacity .35)
 *  with a small "Unstable" label.
 *  Exception: when EVERY server is FAILED nothing is hidden —
 *  all items stay visible, dimmed + labeled, and a
 *  "No healthy servers detected" toast fires once. */
function updateServerDots() {
  const list = $('#server-list');
  if (!list) return;
  const items = [...list.querySelectorAll('.server-item')];
  if (!items.length) return;
  const failedFlags = items.map((el) => isEngineFailed(el.dataset.server));
  const allFailed = failedFlags.every(Boolean);
  items.forEach((el, i) => {
    const id = el.dataset.server;
    const failed = failedFlags[i];
    // GREEN = confirmed OK ... OR the live server that just loaded
    const confirmedOk = isRecentlyOk(id)
      || (!!activeServer && activeServer.id === id && serverLoaded);
    const state = failed ? 'fail' : confirmedOk ? 'ok' : 'unknown';
    const dot = el.querySelector('.server-status-dot');
    if (dot) {
      dot.classList.remove('dot-ok', 'dot-fail', 'dot-unknown');
      dot.classList.add(`dot-${state}`);
    }
    // subtle "maybe ok": latest test hint was OK but the server
    // has NO confirmed data — the dot stays YELLOW, just with a
    // soft halo ring (never green)
    const maybeOk = !failed && !confirmedOk && hasPreflightOkHint(id);
    if (maybeOk) el.setAttribute('data-preflight', 'ok');
    else el.removeAttribute('data-preflight');
    const statusText = state === 'ok' ? 'working recently'
      : state === 'fail' ? 'server failed'
      : maybeOk ? 'test loaded — unverified'
      : 'no recent data';
    el.setAttribute('title', `${el.dataset.name || id} — ${statusText}`);
    el.setAttribute('data-server-status', state);
    // hide only RED CONFIRMED-failed servers — never on a test
    // hint — unless EVERY server failed (an empty list would
    // leave the user with no options at all)
    const hiddenByToggle = hideFailedServers && failed && !allFailed;
    el.classList.toggle('server-item--hidden', hiddenByToggle);
    // dim only confirmed-failed items
    el.classList.toggle('dimmed-failed', failed);
    // "Unstable" label — confirmed evidence ONLY
    const unstable = shouldShowUnstableLabel(id);
    const tag = el.querySelector('.sc-unstable');
    if (tag) tag.hidden = !(unstable && !hiddenByToggle);
  });
  // one-shot toast when the list transitions to all-failed
  if (allFailed) {
    if (list.dataset.allFailToasted !== '1') {
      list.dataset.allFailToasted = '1';
      if (typeof showToast === 'function') {
        showToast('No healthy servers detected — try manually.', 'error');
      }
    }
  } else {
    list.dataset.allFailToasted = '0';
  }
}

/* ---------------- "Test servers" probes + progress overlay ----------------
   Shared probe machinery behind the "Test servers" button:
   - one probe per server (a REAL iframe load test in a
     throwaway hidden iframe — the player is never touched)
   - at most 3 probes in flight
   - live progress overlay inside the player ("Checking sources…",
     "Moving to the next source…", bar + "X of Y checked")
   Results are HINTS ONLY: they are persisted to
   zeus_engine_hints_v1 (lastPreflightOk / lastPreflightFail) and
   never write health stats and never hard-fail a server — FAIL
   status comes exclusively from real load timeouts or user
   reports. Returns a Map of serverKey -> loaded. */

function showSourceCheckOverlay(total, { indeterminate = false } = {}) {
  const overlay = $('#source-check-overlay');
  if (!overlay) return;
  const countEl = $('#source-check-count');
  const totalEl = $('#source-check-total');
  const counter = overlay.querySelector('.source-check-counter');
  const fill = $('#source-check-bar-fill');
  if (totalEl) totalEl.textContent = String(total);
  if (countEl) countEl.textContent = '0';
  if (fill) fill.style.width = '0%';
  overlay.classList.toggle('indeterminate', indeterminate);
  if (counter) counter.hidden = indeterminate;
  overlay.hidden = false;
}

function updateSourceCheckProgress(checked, total) {
  const countEl = $('#source-check-count');
  const fill = $('#source-check-bar-fill');
  if (countEl) countEl.textContent = String(checked);
  if (fill) fill.style.width = total > 0 ? `${Math.round((checked / total) * 100)}%` : '0%';
}

function hideSourceCheckOverlay() {
  const overlay = $('#source-check-overlay');
  if (overlay) overlay.hidden = true;
}

/** Test ONE server by really loading its URL in a throwaway
 *  hidden iframe (8s window). Returns { ok, reason }. The
 *  player iframe is NOT touched. */
async function testServer(server) {
  const url = buildServerUrl(server);
  if (!url) return { ok: false, reason: 'no-url' };
  const testFrame = document.createElement('iframe');
  testFrame.style.position = 'fixed';
  testFrame.style.left = '-9999px';
  testFrame.style.width = '300px';
  testFrame.style.height = '150px';
  testFrame.style.border = '0';
  testFrame.setAttribute('aria-hidden', 'true');
  testFrame.setAttribute('tabindex', '-1');
  testFrame.title = 'server test';
  document.body.appendChild(testFrame);
  try {
    const ok = await loadServerInIframe(url, { timeoutMs: SERVER_TEST_TIMEOUT_MS, frame: testFrame });
    return { ok, reason: ok ? 'loaded' : 'timeout' };
  } finally {
    testFrame.remove();
  }
}

async function runEngineTests(servers) {
  // one test per server key
  const seen = new Set();
  const queue = [];
  servers.forEach((server) => {
    if (!SERVER_URLS[server.id] || seen.has(server.id)) return;
    seen.add(server.id);
    queue.push(server);
  });
  const total = queue.length;
  const results = new Map();
  if (!total) return results;

  showSourceCheckOverlay(total);
  const CONCURRENCY = 3; // never more than 3 probes in flight
  let cursor = 0;
  let checked = 0;

  async function worker() {
    while (cursor < queue.length) {
      const server = queue[cursor];
      cursor += 1;
      const { ok } = await testServer(server);
      results.set(server.id, ok);
      // HINT ONLY: the outcome is persisted to
      // zeus_engine_hints_v1 — a test miss NEVER records a FAIL
      // and never hard-fails the server. The hint only adds a
      // subtle "maybe ok" halo to otherwise-unknown yellow dots.
      recordEngineHint(server.id, ok);
      checked += 1;
      updateSourceCheckProgress(checked, total);
      console.log('[ZEUS] testResult', server.id, ok ? 'loaded' : 'timeout (hint only)');
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    );
  } finally {
    hideSourceCheckOverlay();
  }
  return results;
}

/* ---------------- Server loader + AUTO sequential picker ----------------
   loadServerInIframe() is THE way a server gets loaded: set
   the iframe src and wait — success = the iframe 'load' event
   fires within the timeout (default 10s); a timeout resolves
   false. A newer player load supersedes (and resolves) any
   still-pending one so stale attempts can never resolve
   wrongly. */

/** Load a URL into an iframe. Success = the iframe LOADS within
 *  timeoutMs. Uses the player iframe unless a separate test
 *  frame is passed in. */
function loadServerInIframe(url, { timeoutMs = SERVER_LOAD_TIMEOUT_MS, frame: targetFrame } = {}) {
  return new Promise((resolve) => {
    const frame = targetFrame || $('#player-frame');
    if (!frame) { resolve(false); return; }
    const isPlayer = !targetFrame;
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      frame.removeEventListener('load', onLoad);
      if (timer) clearTimeout(timer);
      if (isPlayer && pendingPlayerLoad === finish) pendingPlayerLoad = null;
      resolve(result);
    };
    const onLoad = () => finish(true); // the iframe loaded = success
    if (isPlayer && pendingPlayerLoad) pendingPlayerLoad(false); // supersede the pending load
    if (isPlayer) pendingPlayerLoad = finish;
    timer = setTimeout(() => finish(false), timeoutMs); // no load in time = fail
    frame.addEventListener('load', onLoad);
    frame.src = url;
  });
}

/** AUTO: simply try every VISIBLE server in list order (no
 *  preflight filtering) — loadServerInIframe proves each one —
 *  and keep the first that loads. All-fail: AutoNext hops to
 *  the next episode (TV, when enabled), otherwise fall back to
 *  the first server. A manual pick while the pass runs aborts
 *  it (the user's choice wins). */
async function autoSelectBestServer({ viaFallback = false } = {}) {
  if (!watchId) return false;
  if (autoSelectRunning || testingServers) return false; // already in flight
  const candidates = getVisibleServers();
  if (!candidates.length) {
    hideSourceCheckOverlay();
    if (typeof showToast === 'function') showToast('No servers available', 'error');
    return false;
  }

  autoSelectRunning = true;
  let userTookOver = false;
  autoSelectAbort = () => { userTookOver = true; };
  try {
    if (typeof showToast === 'function') showToast('AUTO: selecting best source…', 'info');
    console.log('[ZEUS] autoSelect', { servers: candidates.map((s) => s.id) });
    showSourceCheckOverlay(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      const server = candidates[i];
      // load the candidate into the iframe — success = iframe LOADS
      const ok = await setActiveServer(server, viaFallback || i > 0, 'auto');
      updateSourceCheckProgress(i + 1, candidates.length);
      if (userTookOver) return false; // the user picked a server — their pick wins
      if (ok) {
        hideSourceCheckOverlay();
        closeServerModal();
        if (typeof showToast === 'function') {
          showToast('AUTO: selected ' + (server.name || server.id), 'success');
        }
        return true; // loaded — keep it
      }
      // failed (load timeout): already marked FAIL + red — try the next server
    }
    hideSourceCheckOverlay();
    // every server failed — AutoNext hops to the next episode
    // instead of giving up (TV, when enabled)
    if (await autoNextAdvance('sources-failed')) return true;
    if (candidates[0]) {
      if (typeof showToast === 'function') showToast('AUTO: using fallback server', 'info');
      await setActiveServer(candidates[0], true, 'auto');
    }
    closeServerModal();
    return false;
  } finally {
    autoSelectRunning = false;
    autoSelectAbort = null;
  }
}

/* ---------------- "Test servers" ----------------
   Tests every server with a hidden-iframe load probe (3 at a
   time) behind the live progress overlay. Probes are HINTS
   ONLY: a miss NEVER records a FAIL and never hard-fails a
   server. FAIL status (red dots) still comes exclusively from
   real load timeouts or user reports. */
async function testServersForActiveTab() {
  if (testingServers || autoSelectRunning || !watchId) return;
  const servers = getServers();
  if (!servers.length) return;

  testingServers = true;
  const btn = $('#test-servers-btn');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('testing');
  }
  if (typeof showToast === 'function') showToast('Testing servers…', 'info');
  console.log('[ZEUS] testServers', { servers: servers.map((s) => s.id) });

  let currentServerFailed = false;
  try {
    const generation = switchGeneration;
    const results = await runEngineTests(servers);
    // AUTO reacts to REAL failures only: when the server playing
    // RIGHT NOW is FAILED (strict stats rule from real load
    // events — never a probe miss), run the AUTO pass so the
    // player moves to a working source.
    currentServerFailed = generation === switchGeneration
      && !!activeServer
      && isEngineFailed(activeServer.id);
    let loaded = 0;
    results.forEach((ok) => { if (ok) loaded += 1; });
    if (typeof showToast === 'function') {
      showToast(`Done — ${loaded} of ${results.size} loaded`, 'success');
    }
  } finally {
    testingServers = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('testing');
    }
  }
  updateServerDots();
  if (autoMode && currentServerFailed) {
    await autoSelectBestServer({ viaFallback: true });
  }
}

/** "Report server" button: mark the CURRENT server as FAIL
 *  (stats + session hard fail — a user report is one of the
 *  only sanctioned fail events), toast, and switch away through
 *  the AUTO pass so the next source is proven. */
function reportCurrentServer() {
  if (!activeServer || !SERVER_URLS[activeServer.id]) return;
  const reported = activeServer;
  recordServerResult(reported.id, false); // also hard-fails for the session
  console.log('[ZEUS] serverFAIL', reported.id, 'user-report');
  if (typeof showToast === 'function') {
    showToast('Reported. Switching server…', 'info');
  }
  closeServerModal();
  fallbacksUsed = 0; // a report starts a fresh fallback cycle
  autoSelectBestServer();
}

/* ============================================================
   PLAYER: load the active server's embed URL
   ============================================================ */
/** Make SERVER the active server and load its embed URL into
 *  the player. Success = the iframe LOADS within the timeout
 *  (loadServerInIframe) -> GREEN + saved as the default. A load
 *  timeout -> RED (real fail) and, unless this load was part of
 *  an AUTO pass, an automatic fallback pass tries the next
 *  servers. */
async function setActiveServer(server, viaFallback = false, reason = 'manual') {
  if (!server || !SERVER_URLS[server.id]) return false;

  // A user-driven switch aborts any in-flight AUTO pass (the
  // user's pick wins). AUTO's own candidate loads pass through
  // untouched. Hiding the pass's overlay here is safe — a
  // manual pick re-opens it right below.
  if (reason !== 'auto' && autoSelectAbort) {
    autoSelectAbort();
    hideSourceCheckOverlay();
  }

  // A manual pick starts a fresh fallback cycle + resets the
  // AutoNext failure-hop guard
  activeServer = server;
  if (!viaFallback) {
    fallbacksUsed = 0;
    autoNextFailHops = 0;
  }
  switchGeneration += 1; // invalidate any in-flight async server picks
  const generation = switchGeneration;

  highlightActiveServers();

  // Remember the choice for the next visit
  try {
    localStorage.setItem(SERVER_PREF_KEY, JSON.stringify({ id: server.id }));
  } catch (e) { /* storage blocked — session only */ }

  // Build the embed URL for the current title
  const url = buildServerUrl(server);
  if (!url) return false;

  console.log('[ZEUS] switchServer', { serverKey: server.id, url, reason });

  // A manual server click shows the "Checking sources…"
  // progress overlay while the iframe loads (hidden on
  // confirm/fail)
  if (reason === 'manual') {
    manualSourceCheck = true;
    showSourceCheckOverlay(1);
    updateSourceCheckProgress(0, 1);
  }

  // Show loading overlay and swap the iframe source — success
  // = the iframe LOADS within the timeout
  serverLoaded = false;
  showPlayerLoading(true);
  const ok = await loadServerInIframe(url);

  if (generation !== switchGeneration) return ok; // superseded — a newer pick owns the frame

  if (ok) {
    // Confirmed load: GREEN (working) + saved as the user's
    // default server
    serverLoaded = true;
    finishManualSourceCheck();
    showPlayerLoading(false);
    recordServerResult(server.id, true);
    setLastGoodEngine(watchType, server.id);
    console.log('[ZEUS] serverOK', server.id);
    return true;
  }

  // Load timeout = a real failure: RED (stats + session hard
  // fail) — and unless an AUTO pass already owns the rotation,
  // automatically move to the next servers
  recordServerResult(server.id, false);
  finishManualSourceCheck();
  console.log('[ZEUS] serverFAIL', server.id, 'load-timeout');
  if (reason !== 'auto' && !autoSelectRunning) {
    if (fallbacksUsed < MAX_AUTO_FALLBACKS) {
      fallbacksUsed += 1;
      await autoSelectBestServer({ viaFallback: true });
    } else if (!(await autoNextAdvance('fallback-exhausted'))) {
      showPlayerLoading(false);
      if (typeof showToast === 'function') {
        showToast('No working sources — open Servers and try manually.', 'error');
      }
    }
  }
  return false;
}

/** Hide the "Checking sources…" overlay opened by a MANUAL
 *  server pick (TASK 3.1). Called on confirm or fail. */
function finishManualSourceCheck() {
  if (!manualSourceCheck) return;
  manualSourceCheck = false;
  hideSourceCheckOverlay();
}

/** "Reset status" button (PART 7): because users already carry
 *  bad stats from the old buggy health tracking (everything
 *  marked UNSTABLE / failed), this wipes the slate clean —
 *  zeus_engine_stats_v2 + zeus_engine_hints_v1 removed from
 *  localStorage, SESSION_HARD_FAIL and the in-memory hint cache
 *  cleared — then repaints the dots. Playback is NOT touched. */
function resetServerStats() {
  try {
    localStorage.removeItem(SERVER_STATS_KEY);
    localStorage.removeItem(ENGINE_HINTS_KEY);
  } catch (e) { /* storage blocked — session-only reset below */ }
  SESSION_HARD_FAIL.clear();
  Object.keys(engineHintMemory).forEach((k) => delete engineHintMemory[k]);
  updateServerDots();
  console.log('[ZEUS] serverStatsReset');
  if (typeof showToast === 'function') {
    showToast('Server status reset', 'success');
  }
}

function showPlayerLoading(show) {
  const loading = $('#player-loading');
  if (loading) loading.classList.toggle('hidden', !show);
}

/* ============================================================
   CINEMATIC ENTRANCE LIGHTING (≤ 1.8s, click skips)
   ============================================================ */
function playCineEntrance() {
  const overlay = $('#cine-overlay');
  if (!overlay) return;

  // The entrance IS the loader on this page — hide the generic one.
  const pageLoader = $('#page-loader');
  if (pageLoader) pageLoader.style.display = 'none';
  document.documentElement.classList.add('no-page-loader');

  // Reduced motion: skip straight to the content
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    hideCineOverlay(true);
    return;
  }

  overlay.classList.add('cine-playing');

  // Click anywhere skips the show
  overlay.addEventListener('click', () => hideCineOverlay(), { once: true });

  // Timed sequence: sweep 0.1–1.4s, flash ~0.5s, title 0.7s,
  // overlay fades at 1.35s + 0.45s fade = 1.8s total
  window.setTimeout(() => hideCineOverlay(), 1350);
}

/** Fade the overlay out; the player shell scales 0.98 → 1. */
function hideCineOverlay(instant = false) {
  const overlay = $('#cine-overlay');
  if (!overlay || overlay.classList.contains('cine-done')) return;
  overlay.classList.add('cine-done');

  const shell = $('#player-shell');
  if (shell) {
    shell.classList.add('shell-enter');
    window.setTimeout(() => shell.classList.remove('shell-enter'), 700);
  }

  if (instant) {
    overlay.style.display = 'none';
  } else {
    overlay.classList.add('cine-out');
    window.setTimeout(() => { overlay.style.display = 'none'; }, 500);
  }
}

/* ============================================================
   TITLE INFO (below the player)
   ============================================================ */
async function loadWatchInfo() {
  try {
    const data = watchType === 'tv'
      ? await getTVDetails(watchId)
      : await getMovieDetails(watchId);

    const title = getMediaTitle(data);
    const year = getMediaYear(data);
    const rating = data.vote_average ? data.vote_average.toFixed(1) : 'N/A';

    updateMetaTags({
      title: `Watch ${title} (${year}) Online Free | ZEUS`,
      description: data.overview ? data.overview.slice(0, 155) : `Watch ${title} online free in HD.`,
      image: data.backdrop_path ? IMAGE_BASE_URL + BACKDROP_SIZE + data.backdrop_path : undefined
    });

    // Cinematic entrance: backdrop + title
    const cineBackdrop = $('#cine-backdrop');
    if (cineBackdrop && data.backdrop_path) {
      cineBackdrop.style.backgroundImage = `url(${IMAGE_BASE_URL + BACKDROP_SIZE + data.backdrop_path})`;
    }
    const cineTitle = $('#cine-title');
    if (cineTitle && !cineTitle.dataset.set) {
      cineTitle.textContent = title;
      cineTitle.dataset.set = '1';
    }

    // Chrome header (title + runtime / SxE)
    const headerTitle = $('#watch-title');
    const headerSubtitle = $('#watch-subtitle');
    if (headerTitle) headerTitle.textContent = `${title} (${year})`;
    if (headerSubtitle) {
      headerSubtitle.textContent = watchType === 'tv'
        ? `Season ${currentSeason} · Episode ${currentEpisode}`
        : `${formatRuntime(data.runtime)} · Rating ${rating}`;
    }

    // Info card
    const info = $('#watch-info');
    if (info) {
      info.hidden = false;
      const poster = $('#watch-info-poster-img');
      if (poster) poster.src = imageUrl(data.poster_path, POSTER_SIZE);

      const infoTitle = $('#watch-info-title');
      if (infoTitle) infoTitle.textContent = title;

      const meta = $('#watch-info-meta');
      if (meta) {
        const parts = [];
        if (watchType === 'tv') {
          parts.push(`S${currentSeason} E${currentEpisode}`);
          if (episodeCache.has(currentSeason)) {
            const ep = episodeCache.get(currentSeason).find((e) => e.episode_number === currentEpisode);
            if (ep && ep.name) parts.push(ep.name);
          }
        } else {
          parts.push(formatRuntime(data.runtime));
        }
        parts.push(`${rating} / 10`);
        parts.push(formatDate(data.release_date || data.first_air_date));
        if (data.genres && data.genres.length) {
          parts.push(data.genres.slice(0, 3).map((g) => g.name).join(', '));
        }
        meta.innerHTML = parts
          .map((part) => `<span>${escapeHtml(String(part))}</span>`)
          .join('<span class="dot"></span>');
      }

      const overview = $('#watch-overview');
      if (overview) {
        overview.textContent = data.overview || 'No description available.';
      }

      // Watchlist toggle button
      const actions = $('#watch-info-actions');
      if (actions && typeof createWatchlistDetailButton === 'function') {
        actions.innerHTML = createWatchlistDetailButton(data);
      }
    }
    infoLoaded = true;
  } catch (error) {
    const headerTitle = $('#watch-title');
    if (headerTitle) headerTitle.textContent = 'Watch Online Free';
    const headerSubtitle = $('#watch-subtitle');
    if (headerSubtitle && !infoLoaded) {
      headerSubtitle.textContent = 'Could not load title info — player still works below';
    }
  }
}

/* ============================================================
   TV SEASON / EPISODE CONTROLS
   ============================================================ */
async function loadSeasonControls() {
  try {
    const show = await getTVDetails(watchId);
    seasonsCache = (show.seasons || []).filter((s) => s.season_number > 0);

    if (!seasonsCache.length) {
      seasonsCache = [{ season_number: currentSeason, name: `Season ${currentSeason}`, episode_count: 0 }];
    }

    const seasonSelect = $('#watch-season-select');
    if (seasonSelect) {
      seasonSelect.innerHTML = seasonsCache
        .map((s) => `<option value="${s.season_number}">${escapeHtml(s.name || `Season ${s.season_number}`)}</option>`)
        .join('');
      seasonSelect.value = String(currentSeason);
      seasonSelect.addEventListener('change', () => {
        currentSeason = Number(seasonSelect.value);
        currentEpisode = 1;
        syncUrl();
        refreshEpisodeSelect();
        setActiveServer(activeServer, false, 'episode-change');
        updateEpisodeNavButtons();
        loadWatchInfo();
      });
    }

    await refreshEpisodeSelect();
    updateEpisodeNavButtons();
  } catch (error) {
    // Controls are progressive enhancement — the player still works.
    const seasonSelect = $('#watch-season-select');
    if (seasonSelect) {
      seasonSelect.innerHTML = `<option value="${currentSeason}">Season ${currentSeason}</option>`;
    }
    const episodeSelect = $('#watch-episode-select');
    if (episodeSelect) {
      episodeSelect.innerHTML = `<option value="${currentEpisode}">Episode ${currentEpisode}</option>`;
    }
  }
}

async function refreshEpisodeSelect() {
  const episodeSelect = $('#watch-episode-select');
  if (!episodeSelect) return;

  const episodes = await getEpisodes(currentSeason);
  episodeSelect.innerHTML = episodes.length
    ? episodes.map((ep) => {
        const label = `E${String(ep.episode_number).padStart(2, '0')} · ${ep.name || `Episode ${ep.episode_number}`}`;
        return `<option value="${ep.episode_number}">${escapeHtml(label)}</option>`;
      }).join('')
    : `<option value="${currentEpisode}">Episode ${currentEpisode}</option>`;

  // Clamp selection to available range
  if (episodes.length && !episodes.some((ep) => ep.episode_number === currentEpisode)) {
    currentEpisode = episodes[0].episode_number;
  }
  episodeSelect.value = String(currentEpisode);

  // (Re)bind change listener
  episodeSelect.onchange = () => {
    currentEpisode = Number(episodeSelect.value);
    syncUrl();
    setActiveServer(activeServer, false, 'episode-change');
    updateEpisodeNavButtons();
    loadWatchInfo();
  };
}

async function getEpisodes(seasonNumber) {
  if (episodeCache.has(seasonNumber)) {
    return episodeCache.get(seasonNumber);
  }
  try {
    const data = await getSeasonDetails(watchId, seasonNumber);
    const episodes = data.episodes || [];
    episodeCache.set(seasonNumber, episodes);
    return episodes;
  } catch (error) {
    return [];
  }
}

function updateEpisodeNavButtons() {
  const prev = $('#prev-episode');
  const next = $('#next-episode');
  if (prev) prev.disabled = currentSeason === 1 && currentEpisode === 1;
  if (next) next.disabled = false; // enabled; rollover checked on click
}

function syncUrl() {
  const params = new URLSearchParams(window.location.search);
  params.set('id', watchId);
  params.set('type', watchType);
  if (watchType === 'tv') {
    params.set('season', currentSeason);
    params.set('episode', currentEpisode);
  }
  const subtitle = $('#watch-subtitle');
  if (subtitle) {
    subtitle.textContent = watchType === 'tv'
      ? `Season ${currentSeason} · Episode ${currentEpisode}`
      : subtitle.textContent;
  }
  window.history.replaceState(null, '', `watch.html?${params.toString()}`);
}

/* Prev / Next episode buttons */
document.addEventListener('DOMContentLoaded', () => {
  const prev = $('#prev-episode');
  const next = $('#next-episode');

  if (prev) {
    prev.addEventListener('click', async () => {
      if (currentSeason === 1 && currentEpisode === 1) return;
      if (currentEpisode > 1) {
        currentEpisode -= 1;
      } else {
        // Roll back to the previous season's last episode
        const prevSeason = seasonsCache.find(
          (s) => s.season_number === currentSeason - 1
        );
        if (prevSeason) {
          currentSeason -= 1;
          const episodes = await getEpisodes(currentSeason);
          currentEpisode = episodes.length ? episodes[episodes.length - 1].episode_number : 1;
        } else {
          return;
        }
      }
      const seasonSelect = $('#watch-season-select');
      if (seasonSelect) seasonSelect.value = String(currentSeason);
      await refreshEpisodeSelect();
      syncUrl();
      setActiveServer(activeServer, false, 'episode-change');
      updateEpisodeNavButtons();
      loadWatchInfo();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  if (next) {
    next.addEventListener('click', async () => {
      const episodes = await getEpisodes(currentSeason);
      const current = episodes.find((e) => e.episode_number === currentEpisode);
      const hasNextInSeason = episodes.some((e) => e.episode_number === currentEpisode + 1);

      if (hasNextInSeason) {
        currentEpisode += 1;
      } else {
        // Roll forward to the next season's first episode
        const nextSeason = seasonsCache.find(
          (s) => s.season_number === currentSeason + 1
        );
        if (nextSeason) {
          currentSeason += 1;
          currentEpisode = 1;
          const seasonSelect = $('#watch-season-select');
          if (seasonSelect) seasonSelect.value = String(currentSeason);
          await refreshEpisodeSelect();
        } else if (current) {
          next.disabled = true; // last episode of the last season
          return;
        } else {
          return;
        }
      }
      syncUrl();
      setActiveServer(activeServer, false, 'episode-change');
      updateEpisodeNavButtons();
      loadWatchInfo();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
});
