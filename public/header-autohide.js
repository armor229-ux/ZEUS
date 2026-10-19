/* ============================================================
   ZEUS — Header auto-hide (header-autohide.js)
   ------------------------------------------------------------
   Loaded once, just before </body>, on every page that carries
   the ZEUS top bar. ONLY the header reacts — page content never
   shifts:
   • Scrolling DOWN past the top hides the header (gear +
     centered pill + logo slide up and fade out, via the
     data-header-hidden attribute on <html> + the
     --zeus-header-shift variable in style.css).
   • Scrolling UP brings it back; being within 20px of the top
     always shows it.
   • Moving the mouse back to the top edge reveals it too —
     the reveal zone follows the live header bottom, so it
     stays correct with or without the disclaimer banner.
   Banner awareness is already handled natively by ZEUS (the
   fixed disclaimer banner drives --banner-height), so this
   script only owns the hide/show state.
   ============================================================ */
(function () {
  if (window.ZEUSHeaderAutoHide) return; // insert-once guard
  window.ZEUSHeaderAutoHide = true;

  var root = document.documentElement;
  var lastY = window.scrollY || 0;
  var hidden = false;
  var ticking = false;

  function setHidden(state) {
    if (hidden === state) return;
    hidden = state;
    if (state) {
      root.setAttribute('data-header-hidden', '1');
    } else {
      root.removeAttribute('data-header-hidden');
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = window.scrollY || 0;
      var dy = y - lastY;
      if (y < 20) {
        setHidden(false);          // at the top → always visible
      } else if (dy > 8) {
        setHidden(true);           // scrolling down → hide header
      } else if (dy < -6) {
        setHidden(false);          // scrolling up → show header
      }
      lastY = y;
      ticking = false;
    });
  }

  /* Mouse back at the top edge reveals the header even while
     the page is stationary. The zone tracks the real header
     bottom (banner-aware) with a little slack below it.
     The pill is position:fixed (section 33), so it is measured
     directly; the topbar wrapper is kept as a fallback for any
     page without the pill. */
  function revealZone() {
    var bar = document.querySelector('.zeus-navpill')
      || document.querySelector('.zeus-topbar');
    if (bar) {
      var bottom = bar.getBoundingClientRect().bottom;
      if (bottom > 0) return bottom + 28;
    }
    return 96;
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('mousemove', function (e) {
    if (!hidden) return;
    if (e.clientY > 0 && e.clientY < revealZone()) setHidden(false);
  }, { passive: true });

  onScroll(); // sync with a page that loaded mid-scroll (e.g. #hash)
})();
