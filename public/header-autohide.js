/* ============================================================
   ZEUS — Header auto-hide (header-autohide.js)  —  DISABLED
   ------------------------------------------------------------
   v5.2 (board request: "the header must stay visible while
   scrolling — never hide, slide away, or fade out"): the
   auto-hide behaviour is fully disabled. This file is kept as
   a deliberate no-op so the 13 pages' existing <script> tags
   keep loading cleanly (no 404s, no HTML edits). It no longer
   listens to scroll or mousemove and never sets the
   data-header-hidden attribute, so the logo, the nav pill and
   the settings gear are ALWAYS visible.

   Belt-and-suspenders: style.css section 35 also pins all
   three header pieces visible/translated-0 even if
   data-header-hidden were set by anything else.

   To re-enable auto-hide, restore the previous version of this
   file (pre-v5.2 backup: upload/extracted/ZEUS-main zip).

   ------------------------------------------------------------
   GOLD UPDATE (v1.3) — two tiny shared behaviours were APPENDED
   below (the no-op stub above is untouched; nothing here ever
   sets data-header-hidden):
   SEARCH-PILL FIX (v1.4) — the gold Search item (back inside the
   pill, CSS section 38) never takes the active state or the
   white thumb: it navigates to search.html instead. Prevents a
   gold-on-white flash right before the page change.
   BACKGROUND FIX (v1.5) — the scroll-state module below now
   toggles body[data-scrolled] past ~12px of scroll (board
   threshold) and no longer creates the old .zeus-gold-veil
   element: CSS section 39 replaces the veil with a much
   stronger design — the .zeus-bg-blur layer itself transforms
   into the gold gradient plus a screen-blend glow layer
   (body::before). The veil is retired (display:none in CSS 39E)
   so the two mechanisms never stack. Threshold keeps a small
   12/4 hysteresis so sub-pixel scroll jitter at the line can
   never flicker the attribute.
     1. NAV PILL GLIDE — creates .zeus-navpill-thumb inside the
        pill and makes the active state GLIDE between buttons
        (transform/width only, 200ms — CSS 37C). Cross-page
        glides via sessionStorage; in-page switching (index
        anchors) moves the active state live. Skipped entirely
        under prefers-reduced-motion.
     2. SCROLL STATE (data-scrolled) — rAF-throttled, change-
        guarded writes (only touches the attribute when the
        state actually flips — the board's verbatim observer
        variant would loop: setAttribute fires mutation records
        even for identical values). CSS 39 fades the golden
        layers in/out off this attribute.

   PAGE CROSS-FADE (v1.7, BOARD P3) — §4 below fades the page out
   over 150ms (body.page-exit, CSS §49) on qualified same-origin
   link clicks, then navigates; the enter half is a one-shot body
   keyframe in CSS §49. bfcache-safe, reduced-motion-safe, and
   cannot trap a click (navigation fires from a timer even if the
   transition is skipped).
   ============================================================ */
(function () {
  /* intentionally empty — the ZEUS header is always visible */
})();

/* ============================================================
   1. NAV PILL GLIDE (GOLD UPDATE, CSS 37C)
   ============================================================ */
(function () {
  'use strict';

  var pill = document.querySelector('.zeus-navpill');
  if (!pill) return;
  var items = Array.prototype.slice.call(pill.querySelectorAll('.zeus-nav-item'));
  if (!items.length) return;

  var reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* older engines — glide is fine */ }

  var thumb = document.createElement('span');
  thumb.className = 'zeus-navpill-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  pill.appendChild(thumb);
  pill.classList.add('zeus-navpill--glide');

  var lastItem = null; // item the thumb is currently placed on

  function activeItem() {
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains('active')) return items[i];
    }
    return null;
  }

  /* Instant mode uses inline `transition` (NOT classes) so this
     never touches the class attribute — the defensive
     MutationObserver below watches class changes inside the
     pill, and class writes here would feed it a loop. */
  function place(item, instant) {
    if (!item) {
      thumb.style.opacity = '0';
      lastItem = null;
      return;
    }
    if (instant) thumb.style.transition = 'opacity 180ms ease';
    thumb.style.width = item.offsetWidth + 'px';
    /* PART 3 (60fps board): translate3d, never left/top/margin —
       the glide runs on the compositor while the page scrolls. */
    thumb.style.transform = 'translate3d(' + item.offsetLeft + 'px, 0, 0)';
    if (instant) {
      void thumb.offsetWidth; // flush so the NEXT move animates
      thumb.style.transition = '';
    }
    thumb.style.opacity = '1';
    lastItem = item;
  }

  /* initial placement — with an optional cross-page glide:
     the outgoing page stored which item was clicked; if this
     page loads within 6s and the pill has the same items,
     start the thumb there and let it glide home. */
  var prev = null;
  try { prev = JSON.parse(sessionStorage.getItem('zeus_pill_glide') || 'null'); } catch (e) { /* blocked */ }
  try { sessionStorage.removeItem('zeus_pill_glide'); } catch (e) { /* one-shot */ }

  var init = activeItem();
  if (init) {
    var from = null;
    if (prev && Date.now() - (prev.at || 0) < 6000 && prev.count === items.length) {
      from = items[Math.min(Math.max(prev.index || 0, 0), items.length - 1)];
    }
    place(from && from !== init ? from : init, true);
    if (from && from !== init && !reduced) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { place(init, false); });
      });
    }
  }

  /* in-page switching (e.g. index.html Genre/Arabic/Turkish
     anchors) — move the active state + glide the thumb */
  pill.addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('.zeus-nav-item') : null;
    if (!item) return;
    try {
      sessionStorage.setItem('zeus_pill_glide', JSON.stringify({
        at: Date.now(), count: items.length, index: items.indexOf(item)
      }));
    } catch (err) { /* storage blocked — no cross-page glide */ }
    if (item.classList.contains('active')) return;
    /* the gold Search item navigates to search.html — it must never
       take the active state or the white thumb (gold text on the
       white thumb would flash unreadable right before navigation) */
    if (item.classList.contains('zeus-nav-search')) return;
    items.forEach(function (i) { i.classList.toggle('active', i === item); });
    place(item, reduced);
  });

  /* keep aligned on resize (no glide — instant) */
  var rT;
  window.addEventListener('resize', function () {
    clearTimeout(rT);
    rT = setTimeout(function () { place(activeItem(), true); }, 120);
  }, { passive: true });

  /* late/dynamic active changes (defensive — no page currently
     moves the pill's active state after load). The lastItem
     guard keeps our own class toggles from re-triggering it. */
  try {
    new MutationObserver(function () {
      var cur = activeItem();
      if (cur && cur !== lastItem) place(cur, true);
    }).observe(pill, { subtree: true, attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* very old engine — initial placement is enough */ }
})();

/* ============================================================
   2. SCROLL STATE — data-scrolled (BACKGROUND FIX, CSS 39)
   ------------------------------------------------------------
   Toggles body[data-scrolled="1"] past ~12px of scroll.
   The veil element from v1.3/v1.4 is GONE — CSS section 39
   turns .zeus-bg-blur itself golden on scroll plus a glow
   layer on body::before; both fade off this attribute.
   ============================================================ */
(function () {
  'use strict';

  var ticking = false;
  var scrolled = false;

  function update() {
    ticking = false;
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    var on = scrolled ? y > 4 : y > 12; // board threshold 12 + anti-flicker hysteresis
    if (on !== scrolled) {
      scrolled = on;
      if (on) document.body.setAttribute('data-scrolled', '1');
      else document.body.removeAttribute('data-scrolled');
    }
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  }, { passive: true });

  /* mobile URL-bar collapse resizes the viewport and can shift
     scrollY — re-evaluate on resize too (board's script does) */
  window.addEventListener('resize', function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  }, { passive: true });

  update();
})();

/* ============================================================
   3. SCROLL VELOCITY — body[data-scroll-fast] (60FPS BOARD)
   ------------------------------------------------------------
   PART 2/3 plumbing for the permanent scroll-lag fix:

   • ONE window listener, { passive: true } — wheel/touch/
     scrollbar-drag input is never blocked by JavaScript.
   • All work is rAF-gated: attribute writes happen at most
     once per screen refresh (60Hz/120Hz), never per event.
   • The handler NEVER reads layout — window.scrollY is a
     compositor-cached value (no offsetHeight /
     getBoundingClientRect → no forced synchronous reflow).
   • Per-frame velocity (normalized to ~16ms frames) enables
     body[data-scroll-fast] during fast flings and scrollbar
     drags. CSS §46E/§46F temporarily reduces expensive glass
     and card effects. Once enabled, keep that state until the
     gesture settles: switching it at every velocity threshold
     crossing causes costly restyles across long card grids.
   • Native scrollend keeps the guard active throughout a thumb
     drag or touch fling, even when frames stall. Frosted blur and
     hovers return ~140ms after scrolling ends. Older browsers use
     the previous idle-timer fallback. Input remains native.
   ============================================================ */
(function () {
  'use strict';

  var FAST_PX_PER_FRAME = 22;  // ≈1300 px/s — fast fling / drag
  var SETTLE_MS = 140;         // grace after native scroll completion
  var hasScrollEnd = 'onscrollend' in document;

  var ticking = false;
  var fast = false;
  var ended = false;
  var lastY = window.scrollY || 0;
  var lastTs = 0;
  var settleTimer;

  function scheduleRelease() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(function () {
      settleTimer = null;
      // scrollend can arrive before the rAF that enables fast mode.
      if (ticking) {
        scheduleRelease();
        return;
      }
      if (fast) {
        fast = false;
        document.body.removeAttribute('data-scroll-fast');
      }
    }, SETTLE_MS);
  }

  function frame(ts) {
    ticking = false;

    var y = window.scrollY || 0;
    var dy = y - lastY;
    lastY = y;

    // Normalize to 16ms frames; clamp the gap so tab switches
    // (huge ts deltas) can never false-trigger fast mode.
    var dt = lastTs ? (ts - lastTs) : 16;
    lastTs = ts;
    var velocity = Math.abs(dy) * (16 / Math.min(Math.max(dt, 8), 64));

    // Stay in fast mode until the gesture settles, rather than
    // restyling every card when velocity oscillates around the threshold.
    if (!fast && velocity > FAST_PX_PER_FRAME) {
      fast = true;
      document.body.setAttribute('data-scroll-fast', '1');
    }

    // With native scrollend, a quiet interval during a held scrollbar
    // is not the end of the gesture. Avoid toggling every card's styles
    // while the browser is still processing the drag.
    if (!hasScrollEnd || ended) scheduleRelease();
  }

  function onScroll() {
    ended = false;
    // Cancel the pending idle release immediately: a delayed rAF
    // must not let it flip the fast state between scroll events.
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    // Passive + rAF: leave the actual scrolling to the browser.
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(frame);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  if (hasScrollEnd) {
    document.addEventListener('scrollend', function (event) {
      if (event.target !== document) return; // ignore nested carousels
      ended = true;
      scheduleRelease();
    }, { passive: true });
  }

  // Initial state (e.g. page restored mid-scroll by the browser)
  frame(performance.now ? performance.now() : Date.now());
})();

/* ============================================================
   3b. BANNER SAFE TOP
   ------------------------------------------------------------
   Measure the banner only when it or something affecting it
   changes. The old body-wide observer measured on every poster,
   card and hover mutation, forcing style/layout during scroll.
   ============================================================ */
(function () {
  'use strict';

  var selector = '.disclaimer-banner, .notice-bar, .site-banner, .disclaimer-bar, ' +
    '[data-site-banner], #top-banner, #notice, #banner';
  var candidates = [];
  var pending = false;
  var resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleUpdate) : null;

  function updateSafeTop() {
    pending = false;
    var next = Array.prototype.slice.call(document.querySelectorAll(selector));
    if (resizeObserver) {
      candidates.forEach(function (el) {
        if (next.indexOf(el) === -1) resizeObserver.unobserve(el);
      });
      next.forEach(function (el) {
        if (candidates.indexOf(el) === -1) resizeObserver.observe(el);
      });
    }
    candidates = next;

    var height = 0;
    candidates.forEach(function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.top <= 0 && rect.height > height) height = rect.height;
    });
    var value = height + 'px';
    var style = document.documentElement.style;
    if (style.getPropertyValue('--zeus-safe-top') !== value) {
      style.setProperty('--zeus-safe-top', value);
    }
  }

  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(updateSafeTop);
  }

  function containsCandidate(node) {
    if (node.nodeType !== 1) return false;
    return node.matches(selector) || !!node.querySelector(selector) ||
      candidates.some(function (el) { return node.contains(el); });
  }

  function affectsBanner(record) {
    var target = record.target;
    if (record.type === 'attributes') {
      // These two scroll states affect cards/background, not the banner.
      if (target === document.body) {
        return record.attributeName !== 'data-scrolled' &&
          record.attributeName !== 'data-scroll-fast';
      }
      if (target.matches(selector)) return true;
      return candidates.some(function (el) {
        return target.contains(el) || el.contains(target);
      });
    }
    if (candidates.some(function (el) { return el.contains(target); })) return true;
    return Array.prototype.some.call(record.addedNodes, containsCandidate) ||
      Array.prototype.some.call(record.removedNodes, containsCandidate);
  }

  var observer = new MutationObserver(function (records) {
    if (records.some(affectsBanner)) scheduleUpdate();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener('resize', scheduleUpdate, { passive: true });
  // Without ResizeObserver, a late-loading font can reflow the banner
  // without causing a DOM mutation or window resize.
  if (!resizeObserver && document.fonts) {
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', scheduleUpdate);
    if (document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(scheduleUpdate);
  }
  updateSafeTop();
})();

/* ============================================================
   4. PAGE CROSS-FADE — exit half (v1.7, BOARD P3)
   ------------------------------------------------------------
   Enter half = the one-shot body keyframe in CSS §49 (runs
   automatically on every real load). This module adds the exit
   half: a qualified same-origin link click fades the page out
   (body.page-exit → CSS §49 transition, 150ms cubic-bezier)
   and navigation fires at the 150ms mark — the board's
   opacity cross-fade between tabs, with no white flash (the
   root canvas keeps --bg while body fades).

   Safety rails:
   • left-clicks only, no modifier keys — middle/ctrl/shift
     clicks, target=_blank, downloads and special protocols
     fall through to the browser untouched;
   • in-page anchors (#…) and true reloads never fade;
   • pageshow ALWAYS strips body.page-exit — a back/forward
     cache restore can never land on an invisible page;
   • prefers-reduced-motion users navigate instantly (no exit
     listener is registered at all);
   • navigation fires from a plain 150ms timer, so even if the
     CSS transition is skipped the click can never be trapped.
   ============================================================ */
(function () {
  'use strict';

  var reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* older engines — fade applies */ }

  /* bfcache / restore safety: never arrive on a faded-out page.
     Runs for persisted back/forward restores and fresh loads. */
  window.addEventListener('pageshow', function () {
    document.body.classList.remove('page-exit');
  });

  if (reduced) return; // reduced motion: instant navigation only

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;

    var url;
    try { url = new URL(href, window.location.href); } catch (err) { return; }
    if (url.origin !== window.location.origin) return;
    if (url.href === window.location.href) return; /* true reload */
    /* in-page anchor on the same page — let the browser scroll */
    if (url.pathname === window.location.pathname &&
        url.hash && url.hash !== window.location.hash) return;

    e.preventDefault();
    document.body.classList.add('page-exit');
    window.setTimeout(function () {
      try { window.location.assign(url.href); }
      catch (err) { window.location.href = url.href; }
    }, 150);
  });
})();
