/* ============================================================
   ZEUS - watchparty.js
   "Watch Party" button for the playback page (watch.html).

   Click flow:
     1) Resolve the best playable URL:
          <video>.currentSrc  ->  <video>.src
          -> the player <iframe>'s src
          -> window.location.href as a last resort
     2) Attempt WatchParty "autostart" URLs IN THIS ORDER
        (all attempts kept — none removed):
          a) https://www.watchparty.me/create?url=ENCODED_URL
          b) https://www.watchparty.me/?url=ENCODED_URL
          c) https://www.watchparty.me/#url=ENCODED_URL
        Each is opened in a new tab (keeps ZEUS playback running;
        same behavior as before). The first URL that opens wins —
        normally (a). If the browser blocks the popup, (b) and
        (c) are tried the same way before giving up.
     3) Cross-site limitation: a page can never READ a cross-origin
        WatchParty room, so autostart cannot be confirmed from ZEUS
        (and no cross-origin DOM injection is attempted — it is
        impossible and forbidden). Therefore the clipboard safety
        net ALWAYS runs:
          - copy the video URL to the clipboard automatically
          - show "Video link copied. Paste it into WatchParty."
          - redirect to https://www.watchparty.me/
        When a WatchParty tab DID open, that tab already IS the
        redirect target (the link is carried in its URL), so the
        ZEUS player tab stays put — playback is never broken.
        When every open attempt was blocked, the message shows
        first and the current tab redirects to WatchParty.
   Loaded on watch.html only.
   ============================================================ */

'use strict';

const WATCHPARTY_HOME = 'https://www.watchparty.me/';

/* WatchParty URL attempts, tried in this exact order. */
const WATCHPARTY_ATTEMPT_URLS = [
  (encoded) => 'https://www.watchparty.me/create?url=' + encoded, /* 1st */
  (encoded) => 'https://www.watchparty.me/?url=' + encoded,        /* 2nd */
  (encoded) => 'https://www.watchparty.me/#url=' + encoded         /* 3rd */
];

/**
 * Resolve the URL of whatever is currently playing:
 *   1) an HTML5 <video> element (currentSrc, then src)
 *   2) the player <iframe> (#player-frame / title "Video player")
 *   3) window.location.href as a last resort
 */
function watchpartyResolveVideoUrl() {
  const video = document.querySelector('video');
  if (video) {
    const src = video.currentSrc || video.src;
    if (src) return src;
  }
  const frame = document.querySelector('#player-frame') ||
                document.querySelector('iframe[title="Video player"]') ||
                document.querySelector('iframe[src]');
  if (frame && frame.src) return frame.src;
  return window.location.href;
}

/** Copy text to the clipboard, with a legacy execCommand fallback. */
async function watchpartyCopyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) { /* fall through to the legacy path */ }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

/** Small notice — reuses the site's toast system when available. */
function watchpartyNotice(message, type) {
  if (typeof showToast === 'function') {
    showToast(message, type || 'info');
    return;
  }
  /* Defensive fallback (the .toast styles live in style.css on every page) */
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + (type || 'info');
  const span = document.createElement('span');
  span.className = 'toast-message';
  span.textContent = message;
  toast.appendChild(span);
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('removing'), 2300);
  setTimeout(() => toast.remove(), 2800);
}

/**
 * Try to open one WatchParty attempt URL in a new tab.
 * @returns {Window|null} the opened window, or null when blocked.
 */
function watchpartyOpenAttempt(url) {
  try {
    const win = window.open(url, '_blank');
    if (win) {
      try { win.opener = null; } catch (err) { /* cross-origin — ignore */ }
    }
    return win;
  } catch (err) {
    return null;
  }
}

/**
 * Launch Watch Party:
 *   1) Resolve the playing video URL.
 *   2) Walk the attempt URL list in order until one opens in a
 *      new tab (create?url= -> ?url= -> #url=).
 *   3) Autostart can never be confirmed cross-origin, so always:
 *      copy the URL to the clipboard + show the notice
 *      "Video link copied. Paste it into WatchParty."
 *      - tab opened  -> that tab is the redirect (player keeps
 *                       playing here; nothing breaks)
 *      - all blocked -> show the message first, then redirect
 *                       this tab to https://www.watchparty.me/
 */
async function watchpartyLaunch() {
  const videoUrl = watchpartyResolveVideoUrl();
  const encoded = encodeURIComponent(videoUrl);

  /* ---- Step 2: the ordered autostart attempts ---- */
  let opened = null;
  for (let i = 0; i < WATCHPARTY_ATTEMPT_URLS.length; i++) {
    opened = watchpartyOpenAttempt(WATCHPARTY_ATTEMPT_URLS[i](encoded));
    if (opened) break; /* this attempt opened — WatchParty has the URL */
  }

  /* ---- Step 3: clipboard safety net (autostart unverifiable) ---- */
  const copied = await watchpartyCopyToClipboard(videoUrl);
  if (copied) {
    watchpartyNotice('Video link copied. Paste it into WatchParty.', 'info');
  } else {
    watchpartyNotice('Video link (copy manually): ' + videoUrl, 'info');
  }

  /* No WatchParty tab could be opened at all (popup blocked):
     after the message, send this tab to WatchParty instead. */
  if (!opened) {
    setTimeout(() => { window.location.href = WATCHPARTY_HOME; }, 2600);
  }
}

/** Add the Watch Party button next to the Servers picker (idempotent). */
function watchpartyInjectButton() {
  const mount = document.querySelector('#player-shell .chrome-right');
  if (!mount) return;
  if (document.getElementById('watch-party-btn')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chrome-btn chrome-btn--watchparty';
  button.id = 'watch-party-btn';
  button.title = 'Watch this together with friends on WatchParty';
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>' +
    '<span>Watch Party</span>';
  button.addEventListener('click', watchpartyLaunch);
  mount.appendChild(button);
}

document.addEventListener('DOMContentLoaded', watchpartyInjectButton);
