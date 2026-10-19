/* ============================================================
   ZEUS - watchlist.js
   Watchlist / Favorites feature powered by localStorage.
   Shared by every page: heart buttons on all movie cards,
   an "Add to Watchlist" button on detail/watch pages, toast
   notifications, cross-tab syncing and the Watchlist page
   itself (watchlist.html).
   ============================================================ */

'use strict';

/* ---------------- Storage ---------------- */
const WATCHLIST_STORAGE_KEY = 'streamverse_watchlist';

/**
 * Read the saved watchlist from localStorage.
 * Corrupted / unavailable storage degrades gracefully to [].
 * @returns {Array<Object>} saved items (newest first)
 */
function getWatchlist() {
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

/**
 * Persist the watchlist to localStorage.
 * @param {Array<Object>} list
 * @returns {boolean} true when saved successfully
 */
function saveWatchlist(list) {
  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (error) {
    showToast('Could not save your watchlist — storage is full or blocked.', 'error');
    return false;
  }
}

/** Number of saved items. */
function watchlistCount() {
  return getWatchlist().length;
}

/**
 * Check whether a title is already saved.
 * @param {number|string} id TMDB id
 * @param {string} mediaType 'movie' | 'tv'
 */
function isInWatchlist(id, mediaType) {
  const key = String(id);
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  return getWatchlist().some((item) => String(item.id) === key && item.media_type === type);
}

/**
 * Normalize any TMDB item (card, details, search result) into the
 * compact shape stored in localStorage.
 */
function toWatchlistItem(item) {
  return {
    id: item.id,
    media_type: getMediaType(item) === 'tv' ? 'tv' : 'movie',
    title: getMediaTitle(item),
    poster_path: item.poster_path || null,
    vote_average: item.vote_average || 0,
    release_date: item.release_date || item.first_air_date || '',
    added_at: Date.now()
  };
}

/**
 * Add a title to the watchlist (newest first, deduped).
 * @param {Object} item TMDB item (raw or already normalized)
 * @returns {boolean} true when it was added
 */
function addToWatchlist(item) {
  if (isInWatchlist(item.id, item.media_type)) return false;
  const list = getWatchlist();
  list.unshift(toWatchlistItem(item));
  return saveWatchlist(list);
}

/**
 * Remove a title from the watchlist.
 * @returns {boolean} true when it was removed
 */
function removeFromWatchlist(id, mediaType) {
  const key = String(id);
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const list = getWatchlist();
  const next = list.filter((item) => !(String(item.id) === key && item.media_type === type));
  if (next.length === list.length) return false;
  return saveWatchlist(next);
}

/**
 * Toggle a title in the watchlist.
 * @param {Object} item TMDB item (raw or already normalized)
 * @returns {boolean} true when ADDED, false when REMOVED
 */
function toggleWatchlist(item) {
  const type = item.media_type === 'tv' ? 'tv' : 'movie';
  if (isInWatchlist(item.id, type)) {
    removeFromWatchlist(item.id, type);
    return false;
  }
  addToWatchlist(item);
  return true;
}

/** Empty the whole watchlist. */
function clearWatchlist() {
  try {
    window.localStorage.removeItem(WATCHLIST_STORAGE_KEY);
    return true;
  } catch (error) {
    return false;
  }
}

/* ============================================================
   BUTTON BUILDERS
   ============================================================ */

/** Shared heart icon (outline -> filled via .active CSS). */
const WATCHLIST_HEART_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

/**
 * Heart button shown on every movie card (positioned over the
 * poster by CSS). Carries all data needed to save the title
 * without re-fetching it.
 */
function createWatchlistCardButton(item) {
  const normalized = toWatchlistItem(item);
  const inList = isInWatchlist(normalized.id, normalized.media_type);
  const title = escapeHtml(normalized.title);
  return `
    <button class="watchlist-btn${inList ? ' active' : ''}" type="button"
            data-id="${normalized.id}"
            data-type="${normalized.media_type}"
            data-title="${title}"
            data-poster="${normalized.poster_path || ''}"
            data-rating="${normalized.vote_average || 0}"
            data-date="${normalized.release_date || ''}"
            aria-pressed="${inList}"
            aria-label="${inList ? 'Remove ' + title + ' from watchlist' : 'Add ' + title + ' to watchlist'}"
            title="${inList ? 'Remove from Watchlist' : 'Add to Watchlist'}">
      ${WATCHLIST_HEART_SVG}
    </button>
  `;
}

/**
 * Full "Add to Watchlist" button for detail / watch pages
 * (rendered inside .detail-actions or .watch-info-actions).
 */
function createWatchlistDetailButton(item) {
  const normalized = toWatchlistItem(item);
  const inList = isInWatchlist(normalized.id, normalized.media_type);
  const title = escapeHtml(normalized.title);
  return `
    <button class="btn btn-glass watchlist-btn watchlist-detail-btn${inList ? ' active' : ''}" type="button"
            data-id="${normalized.id}"
            data-type="${normalized.media_type}"
            data-title="${title}"
            data-poster="${normalized.poster_path || ''}"
            data-rating="${normalized.vote_average || 0}"
            data-date="${normalized.release_date || ''}"
            aria-pressed="${inList}"
            aria-label="${inList ? 'Remove ' + title + ' from watchlist' : 'Add ' + title + ' to watchlist'}"
            title="${inList ? 'Remove from Watchlist' : 'Add to Watchlist'}">
      ${WATCHLIST_HEART_SVG}
      <span class="wl-label">${inList ? 'In Watchlist' : 'Add to Watchlist'}</span>
    </button>
  `;
}

/**
 * Refresh every watchlist button currently in the DOM so card
 * hearts, detail buttons and the watchlist page stay in sync.
 */
function updateWatchlistButtonStates() {
  $$('.watchlist-btn').forEach((btn) => {
    const id = btn.dataset.id;
    const type = btn.dataset.type;
    if (!id) return;
    const inList = isInWatchlist(id, type);

    btn.classList.toggle('active', inList);
    btn.setAttribute('aria-pressed', String(inList));

    const title = btn.dataset.title || 'this title';
    const action = inList ? 'Remove' : 'Add';
    btn.setAttribute('aria-label', `${action} ${title} ${inList ? 'from' : 'to'} watchlist`);
    btn.title = inList ? 'Remove from Watchlist' : 'Add to Watchlist';

    const label = btn.querySelector('.wl-label');
    if (label) label.textContent = inList ? 'In Watchlist' : 'Add to Watchlist';
  });

  // Keep an optional watchlist counter chip in the navbar fresh.
  $$('.watchlist-count-chip').forEach((chip) => {
    const count = watchlistCount();
    chip.textContent = String(count);
    chip.hidden = count === 0;
  });
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */

let toastContainer = null;

/** Lazy-create the fixed toast container. */
function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  toastContainer.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastContainer);
  return toastContainer;
}

/**
 * Show a short toast message (bottom-right).
 * @param {string} message
 * @param {'success'|'info'|'error'} type
 */
function showToast(message, type = 'success') {
  const container = ensureToastContainer();
  if (!container) return;

  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.4-4-4 1.4-1.4 2.6 2.6 5.8-5.8 1.4 1.4z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('removing'), 2300);
  setTimeout(() => toast.remove(), 2800);
}

/* ============================================================
   GLOBAL UI WIRING (runs on every page via initCommonUI)
   ============================================================ */

let watchlistUIInitialized = false;

/**
 * Wires global watchlist behaviour: delegated click handling for
 * every .watchlist-btn, cross-tab storage syncing, the navbar
 * counter chip and — when present — the Watchlist page itself.
 */
function initWatchlistUI() {
  if (watchlistUIInitialized) return;
  watchlistUIInitialized = true;

  // Delegated clicks: works for every card rendered later on.
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.watchlist-btn');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();

    const item = {
      id: btn.dataset.id,
      media_type: btn.dataset.type,
      title: btn.dataset.title || 'Untitled',
      poster_path: btn.dataset.poster || null,
      vote_average: Number(btn.dataset.rating) || 0,
      release_date: btn.dataset.date || ''
    };

    const added = toggleWatchlist(item);
    if (added) {
      showToast(`Added "${item.title}" to your watchlist.`, 'success');
    } else {
      showToast(`Removed "${item.title}" from your watchlist.`, 'info');
    }

    updateWatchlistButtonStates();
    const grid = $('#watchlist-grid');
    if (grid) renderWatchlistPage(); // live update when on the watchlist page
  });

  // Cross-tab / cross-window syncing.
  window.addEventListener('storage', (event) => {
    if (event.key !== WATCHLIST_STORAGE_KEY) return;
    updateWatchlistButtonStates();
    if ($('#watchlist-grid')) renderWatchlistPage();
  });

  // Watchlist page: render immediately (DOM already parsed —
  // initCommonUI runs inside each page's DOMContentLoaded).
  if ($('#watchlist-grid')) renderWatchlistPage();
}

/* ============================================================
   WATCHLIST PAGE (watchlist.html)
   ============================================================ */

/** Re-render the whole watchlist page content. */
function renderWatchlistPage() {
  const grid = $('#watchlist-grid');
  if (!grid) return;

  const subtitle = $('#watchlist-subtitle');
  const clearBtn = $('#clear-watchlist-btn');
  const items = getWatchlist(); // stored newest-first

  // Header copy
  if (subtitle) {
    subtitle.textContent = items.length
      ? `You have ${items.length} saved ${items.length === 1 ? 'title' : 'titles'} — ready when you are.`
      : 'Save movies and TV shows with the heart button and find them here on any visit.';
  }
  if (clearBtn) clearBtn.hidden = items.length === 0;

  if (!items.length) {
    grid.innerHTML = '';
    showEmptyState(grid, 'Your watchlist is empty. Tap the heart on any poster to save it here.');
    return;
  }

  grid.innerHTML = '';
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(createMovieCard(item)));
  grid.appendChild(fragment);
  updateWatchlistButtonStates();
}

/** "Clear All" handler for the watchlist page. */
function initClearWatchlistButton() {
  const clearBtn = $('#clear-watchlist-btn');
  if (!clearBtn) return;
  clearBtn.addEventListener('click', () => {
    if (!watchlistCount()) return;
    clearWatchlist();
    showToast('Watchlist cleared.', 'info');
    renderWatchlistPage();
    updateWatchlistButtonStates();
  });
}

/* Auto-init: on watchlist.html (no dedicated page script) run the
   common UI ourselves; elsewhere page scripts call initCommonUI. */
document.addEventListener('DOMContentLoaded', () => {
  if ($('#watchlist-grid')) {
    if (typeof initCommonUI === 'function') initCommonUI();
  }
  initClearWatchlistButton();
});
