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
    thumb.style.transform = 'translateX(' + item.offsetLeft + 'px)';
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
