/* ============================================================
   ZEUS - watchparty.js
   "Watch Party" button for the playback page (watch.html).

   Click flow:
     1) Resolve the best playable URL:
          <video>.currentSrc  ->  <video>.src
          -> the player <iframe>'s src
          -> window.location.href as a last resort
     2) Resolve the current title (#watch-title, falling back to
        #watch-info-title, then document.title).
     3) Open the ZEUS party room (party.html) in a NEW TAB:
          /party.html?url=ENCODED_CURRENT_URL&title=ENCODED_TITLE
        The party page auto-creates a room on the party backend
        (your deployed Cloudflare Worker — party-worker/), auto-fills
        the URL and — for YouTube links and direct .mp4 files —
        syncs playback for everyone. Other sources show a
        "can't be synced" notice while the room + chat still work.
     4) If the browser blocks the popup: copy the party link to
        the clipboard, show a notice, and redirect this tab to the
        party page instead.
   Loaded on watch.html only.
   ============================================================ */

'use strict';

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

/**
 * Resolve the current title for the party page:
 *   1) the chrome header title (#watch-title — "Fight Club (1999)")
 *   2) the info card title (#watch-info-title)
 *   3) document.title as a last resort
 */
function watchpartyResolveTitle() {
  const chromeTitle = document.getElementById('watch-title');
  let t = chromeTitle ? chromeTitle.textContent.trim() : '';
  if (!t || t === 'Loading title…') {
    const infoTitle = document.getElementById('watch-info-title');
    t = infoTitle ? infoTitle.textContent.trim() : '';
  }
  return t || document.title;
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
 * Launch the ZEUS Watch Party room:
 *   1) Resolve the playing video URL + the current title.
 *   2) Open party.html?url=...&title=... in a new tab (ZEUS
 *      playback keeps running here).
 *   3) If the popup was blocked: copy the party link, show a
 *      notice, then redirect this tab to the party page.
 */
async function watchpartyLaunch() {
  const videoUrl = watchpartyResolveVideoUrl();
  const title = watchpartyResolveTitle();
  const partyUrl = '/party.html?url=' + encodeURIComponent(videoUrl) +
                   '&title=' + encodeURIComponent(title);

  /* ---- Step 2: open the party room in a new tab ---- */
  const opened = watchpartyOpenAttempt(partyUrl);
  if (opened) {
    watchpartyNotice('Opening your party room…', 'info');
    return;
  }

  /* ---- Step 3: popup blocked — copy the link, redirect here ---- */
  const absolute = new URL(partyUrl, window.location.href).href;
  const copied = await watchpartyCopyToClipboard(absolute);
  if (copied) {
    watchpartyNotice('Party link copied — opening the party…', 'info');
  } else {
    watchpartyNotice('Party link (copy manually): ' + absolute, 'info');
  }
  setTimeout(() => { window.location.href = partyUrl; }, 2000);
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
  button.title = 'Watch this together with friends — ZEUS Party';
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>' +
    '<span>Watch Party</span>';
  button.addEventListener('click', watchpartyLaunch);
  mount.appendChild(button);
}

document.addEventListener('DOMContentLoaded', watchpartyInjectButton);
