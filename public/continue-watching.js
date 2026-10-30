/* ============================================================
   ZEUS — continue-watching.js
   ------------------------------------------------------------
   Lightweight "Continue Watching" feature (localStorage only,
   no backend, no libraries):

   • RECORDING (watch.html): watch.js calls ZeusCW.begin({...})
     from loadWatchInfo() — once on open and again on every
     in-page episode change. Progress is tracked two ways:
       1. REAL position — best-effort postMessage events from
          the source player (origin-checked, like watch.js's
          own AutoNext listener). When a source reports its
          currentTime, that becomes the saved position.
       2. FALLBACK estimate — while the tab is visible, elapsed
          watch time is accumulated (5s ticks) and capped at
          the title's runtime. Third-party embeds don't expose
          their video element, so this keeps the row useful on
          every source.
   • RESUME: the homepage card links to
     watch.html?...&t=<savedSeconds>; begin() consumes `t`
     exactly once per page load (then strips it from the URL)
     so progress continues from the saved timestamp instead of
     restarting.
   • HOMEPAGE (index.html): renderHomepage() fills #cw-row and
     reveals #section-continue ONLY when progress exists — no
     empty row, ever. Same .content-section / .movies-row /
     .movie-card system as every other row, plus a gold resume
     progress bar, an always-visible caption and a remove
     button (37A in style.css).

   Storage: localStorage "zeus_continue_watching_v1" — an array
   of entries (max 20, newest first). Finished titles (≥ 97.5%)
   are dropped automatically. TV shows keep ONE entry per show
   (the last watched episode), like Netflix.
   ============================================================ */

(function () {
  'use strict';

  var KEY = 'zeus_continue_watching_v1';
  var MAX_ITEMS = 20;
  var FINISHED = 0.975;         // pct at which a title is dropped
  var MIN_SAVED_SEC = 30;       // below this there is nothing to resume
  var TICK_MS = 5000;           // fallback accumulation tick
  var SAVE_EVERY_TICKS = 2;     // persist every ~10s
  var DEFAULT_RUNTIME_MOVIE = 105 * 60;
  var DEFAULT_RUNTIME_TV = 42 * 60;

  /* ---------------- storage ---------------- */

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }

  function save(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    } catch (e) { /* storage blocked / quota — memory only */ }
  }

  function keyOf(entry) {
    return entry.type === 'tv' ? 'tv/' + entry.id : 'movie/' + entry.id;
  }

  /* ---------------- helpers (standalone — no api.js dependency,
     but reuse its globals when present) ---------------- */

  function esc(str) {
    str = String(str == null ? '' : str);
    if (typeof escapeHtml === 'function') return escapeHtml(str);
    return str.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function posterUrl(entry) {
    var path = entry.posterPath || entry.backdropPath;
    if (!path) return (typeof FALLBACK_POSTER === 'string') ? FALLBACK_POSTER : '';
    if (typeof IMAGE_BASE_URL === 'string' && typeof POSTER_SIZE === 'string') {
      return IMAGE_BASE_URL + POSTER_SIZE + path;
    }
    return 'https://image.tmdb.org/t/p/w342' + path;
  }

  function fmtRemaining(sec) {
    if (!isFinite(sec) || sec <= 60) return 'Almost done';
    if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + 'm left';
    var h = Math.floor(sec / 3600);
    var m = Math.round((sec % 3600) / 60);
    return h + 'h ' + (m > 0 ? m + 'm ' : '') + 'left';
  }

  function runtimeOf(entry) {
    if (entry.runtimeSec && entry.runtimeSec > 60) return entry.runtimeSec;
    return entry.type === 'tv' ? DEFAULT_RUNTIME_TV : DEFAULT_RUNTIME_MOVIE;
  }

  function pctOf(entry) {
    var runtime = runtimeOf(entry);
    return Math.min(1, Math.max(0, (entry.watchedSec || 0) / runtime));
  }

  function watchHref(entry) {
    var href = 'watch.html?id=' + encodeURIComponent(entry.id) + '&type=' + entry.type;
    if (entry.type === 'tv') {
      href += '&season=' + (entry.season || 1) + '&episode=' + (entry.episode || 1);
    }
    var t = Math.floor(entry.watchedSec || 0);
    if (t > 0) href += '&t=' + t;
    return href;
  }

  /* ---------------- homepage rendering ---------------- */

  function cardHtml(entry) {
    var pct = pctOf(entry);
    var pctText = Math.round(pct * 100) + '% watched';
    var remaining = fmtRemaining(runtimeOf(entry) - (entry.watchedSec || 0));
    var epHtml = entry.type === 'tv'
      ? '<span class="cw-meta-ep">S' + (entry.season || 1) + '·E' + (entry.episode || 1) + '</span><span class="dot"></span>'
      : '';
    var art = posterUrl(entry);
    var title = entry.title || 'Untitled';

    return ''
      + '<article class="movie-card cw-card" data-cw-key="' + esc(keyOf(entry)) + '">'
      +   '<a class="card-link" href="' + esc(watchHref(entry)) + '" title="' + esc(title) + ' — resume">'
      +     '<div class="poster-wrap">'
      +       '<img class="poster-img" src="' + esc(art) + '" alt="' + esc(title) + ' poster"'
      +            ' loading="lazy" decoding="async"'
      +            (typeof handleImageError === 'function' ? ' onerror="handleImageError(this)"' : '')
      +            ' data-fallback="poster">'
      +       '<div class="cw-progress" role="progressbar" aria-valuenow="' + Math.round(pct * 100) + '"'
      +            ' aria-valuemin="0" aria-valuemax="100" aria-label="' + esc(title) + ' progress">'
      +         '<div class="cw-progress-fill" style="width:' + (pct * 100).toFixed(1) + '%"></div>'
      +       '</div>'
      +     '</div>'
      +   '</a>'
      +   '<button class="cw-remove" type="button" aria-label="Remove ' + esc(title) + ' from Continue Watching">'
      +     '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
      +   '</button>'
      +   '<div class="card-caption">'
      +     '<h3 class="card-caption-title">' + esc(title) + '</h3>'
      +     '<p class="card-caption-meta">'
      +       epHtml
      +       '<span class="cw-meta-pct">' + pctText + '</span>'
      +       '<span class="dot"></span>'
      +       '<span>' + remaining + '</span>'
      +     '</p>'
      +   '</div>'
      + '</article>';
  }

  function visibleEntries() {
    return load()
      .filter(function (e) {
        return e && e.id && (e.watchedSec || 0) >= MIN_SAVED_SEC && pctOf(e) < FINISHED;
      })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .slice(0, MAX_ITEMS);
  }

  function renderHomepage() {
    var row = document.getElementById('cw-row');
    if (!row) return;
    var section = document.getElementById('section-continue');
    var items = visibleEntries();

    if (!items.length) {
      row.innerHTML = '';
      if (section) section.hidden = true;
      return;
    }

    row.innerHTML = items.map(cardHtml).join('');

    // remove buttons
    Array.prototype.forEach.call(row.querySelectorAll('.cw-remove'), function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var key = btn.closest('.cw-card').getAttribute('data-cw-key');
        save(load().filter(function (e) { return keyOf(e) !== key; }));
        renderHomepage();
      });
    });

    if (section) section.hidden = false;
    // let index.js's arrow logic recompute enabled/disabled states
    row.dispatchEvent(new Event('scroll', { bubbles: false }));
  }

  /* ---------------- recording (watch page) ---------------- */

  var session = null;      // live entry reference while on watch.html
  var tickCount = 0;
  var tConsumed = false;   // `t` applies once per page load
  var lastRealSave = 0;

  function persistSession() {
    if (!session) return;
    var items = load().filter(function (e) { return keyOf(e) !== session.key; });
    session.updatedAt = Date.now();
    items.unshift({
      key: session.key, id: session.id, type: session.type,
      title: session.title, year: session.year,
      posterPath: session.posterPath, backdropPath: session.backdropPath,
      season: session.season, episode: session.episode,
      runtimeSec: session.runtimeSec, watchedSec: Math.round(session.watchedSec),
      real: !!session.real, updatedAt: session.updatedAt
    });
    save(items);
  }

  function upsert(entry) {
    // entry: {id, type, title, year, posterPath, backdropPath,
    //         season, episode, runtimeMin}
    if (!entry || !entry.id) return;
    var key = entry.type === 'tv' ? 'tv/' + entry.id : 'movie/' + entry.id;
    var existing = load().filter(function (e) { return e.key === key; })[0] || null;

    var runtimeSec = entry.runtimeMin && entry.runtimeMin > 1
      ? Math.round(entry.runtimeMin * 60)
      : (existing && existing.runtimeSec) || null;

    var watchedSec = existing ? (existing.watchedSec || 0) : 0;
    var real = existing ? !!existing.real : false;

    var epChanged = entry.type === 'tv' && existing
      && (existing.season !== (entry.season || 1) || existing.episode !== (entry.episode || 1));
    if (epChanged) { watchedSec = 0; real = false; }

    // resume seed — exactly once per page load (the homepage CW
    // card passes t=<last saved seconds>)
    if (!tConsumed) {
      tConsumed = true;
      var m = /(?:^|[?&])t=(\d+)/.exec(window.location.search);
      if (m) {
        watchedSec = Math.max(0, parseInt(m[1], 10) || 0);
        real = false;
        // strip t so a later refresh / episode change can't re-seed
        try {
          var clean = new URLSearchParams(window.location.search);
          clean.delete('t');
          var qs = clean.toString();
          window.history.replaceState(null, '', 'watch.html' + (qs ? '?' + qs : ''));
        } catch (e) { /* replaceState unavailable — flag already guards */ }
      }
    }

    session = {
      key: key, id: entry.id, type: entry.type === 'tv' ? 'tv' : 'movie',
      title: entry.title || '', year: entry.year || '',
      posterPath: entry.posterPath || '', backdropPath: entry.backdropPath || '',
      season: entry.type === 'tv' ? (entry.season || 1) : null,
      episode: entry.type === 'tv' ? (entry.episode || 1) : null,
      runtimeSec: runtimeSec,
      watchedSec: Math.min(watchedSec, runtimeSec || Infinity),
      real: real
    };
    persistSession();
  }

  function startTicker() {
    window.setInterval(function () {
      if (!session || document.hidden || session.real) return;
      var runtime = runtimeOf(session);
      if (session.watchedSec >= runtime) return; // finished — stop counting
      session.watchedSec = Math.min(runtime, session.watchedSec + TICK_MS / 1000);
      tickCount++;
      if (tickCount % SAVE_EVERY_TICKS === 0) persistSession();
    }, TICK_MS);

    // flush on hide / leave so nothing is lost
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) persistSession();
    });
    window.addEventListener('pagehide', persistSession);
  }

  /* Best-effort REAL position from the source player. Shapes
     vary by source (VidLink & friends): {type:'player:time',
     data:{currentTime,duration}} or {event:'timeupdate',
     currentTime} — accept them all, origin-checked exactly
     like watch.js's own message listener. */
  function startRealTimeListener() {
    window.addEventListener('message', function (event) {
      if (!session) return;
      try {
        var frame = document.getElementById('player-frame');
        if (!frame || !frame.src) return;
        var frameOrigin;
        try { frameOrigin = new URL(frame.src).origin; } catch (e) { return; }
        if (event.origin !== frameOrigin) return; // not from our source

        var d = event.data;
        if (typeof d === 'string') {
          try { d = JSON.parse(d); } catch (e) { d = { type: d }; }
        }
        if (!d || typeof d !== 'object') return;

        var t = String(d.type || d.event || d.action || '').toLowerCase();
        var nested = d.data || {};
        var ntype = String(nested.type || nested.event || '').toLowerCase();
        var isTime = /(^|[:_-])(time|progress|timeupdate)/.test(t + '|' + ntype);
        if (!isTime) return;

        var cur = Number(nested.currentTime != null ? nested.currentTime
          : nested.time != null ? nested.time
          : d.currentTime != null ? d.currentTime : NaN);
        if (!isFinite(cur) || cur < 0 || cur > 86400) return;

        session.real = true;
        session.watchedSec = cur;
        var dur = Number(nested.duration != null ? nested.duration
          : d.duration != null ? d.duration : NaN);
        if (isFinite(dur) && dur > 60) session.runtimeSec = Math.round(dur);

        var now = Date.now();
        if (now - lastRealSave > 2000) {
          lastRealSave = now;
          persistSession();
        }
      } catch (e) { /* foreign message — ignore */ }
    });
  }

  /* ---------------- public API ---------------- */

  window.ZeusCW = {
    /** Called by watch.js (loadWatchInfo). Safe to call repeatedly. */
    begin: function (entry) {
      try { upsert(entry); } catch (e) { /* never break playback */ }
    },
    /** Called by the homepage. No-op when the row is absent. */
    renderHomepage: function () {
      try { renderHomepage(); } catch (e) { /* never break the homepage */ }
    },
    /** All resumable entries, newest first (used by tests/tools). */
    list: visibleEntries,
    /** Remove one entry by key ('movie/123' | 'tv/123'). */
    remove: function (key) {
      save(load().filter(function (e) { return e.key !== key; }));
    }
  };

  /* ---------------- boot ---------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      renderHomepage();
      startTicker();
      startRealTimeListener();
    });
  } else {
    renderHomepage();
    startTicker();
    startRealTimeListener();
  }

  // another tab changed the list — keep the homepage row fresh
  window.addEventListener('storage', function (ev) {
    if (ev && ev.key === KEY) renderHomepage();
  });
})();
