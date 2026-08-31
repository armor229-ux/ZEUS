/* ============================================================
   ZEUS - watchparty.js
   "Watch Party" button for the playback page (watch.html):
   resolves the currently playing video URL and opens
   WatchParty, falling back to copy-link + redirect when the
   create flow can't be opened (e.g. popup blocked).
   Loaded on watch.html only.
   ============================================================ */

'use strict';

const WATCHPARTY_HOME = 'https://www.watchparty.me/';
const WATCHPARTY_CREATE_BASE = 'https://www.watchparty.me/create?url=';

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
 * Launch WatchParty:
 *   1) First attempt: the create-with-video flow
 *      https://www.watchparty.me/create?url=ENCODED_VIDEO_URL —
 *      opened in a new tab so playback here keeps running
 *      (nothing breaks if the user closes it or backs out).
 *   2) Fallback (popup blocked / open failed): copy the video
 *      URL to the clipboard automatically, show the notice
 *      "Video link copied. Paste it into WatchParty.", then
 *      redirect to https://www.watchparty.me/
 */
async function watchpartyLaunch() {
  const videoUrl = watchpartyResolveVideoUrl();
  const createUrl = WATCHPARTY_CREATE_BASE + encodeURIComponent(videoUrl);

  let opened = null;
  try {
    opened = window.open(createUrl, '_blank');
    if (opened) {
      try { opened.opener = null; } catch (err) { /* cross-origin — ignore */ }
    }
  } catch (err) {
    opened = null;
  }

  if (opened) return; /* WatchParty create flow is opening — done */

  /* Fallback: clipboard + notice + redirect */
  const copied = await watchpartyCopyToClipboard(videoUrl);
  watchpartyNotice(copied
    ? 'Video link copied. Paste it into WatchParty.'
    : 'Video link (copy manually): ' + videoUrl);
  setTimeout(() => { window.location.href = WATCHPARTY_HOME; }, 2600);
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
