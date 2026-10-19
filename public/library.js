/* ============================================================
   ZEUS - library.js
   Per-user local libraries for the Account page, stored in
   localStorage ONLY (no server). Loaded after auth.js on the
   pages that have watchlist hearts / the watch page.

   Storage contract (one key per user):
     zeus_user_library_<USER_ID> => {
       likes:          [ { id, title, poster, type, addedAt, year } ],
       favoriteMovies: [ ... ],
       watchedMovies:  [ ... ],
       favoriteSeries: [ ... ]
     }
   type is "movie" | "series".

   Integration (no existing files touched):
   - The site's watchlist hearts (watchlist.js global functions)
     are wrapped so every add/remove is mirrored into the signed-in
     user's Favorite Movies (movie) / Favorite Series (tv) section.
   - On watch.html, a movie opened by a signed-in user is added
     once to Watched Movies.
   ============================================================ */

'use strict';

(function () {

  /* ---------------- Config ---------------- */
  const LIBRARY_KEY_PREFIX = 'zeus_user_library_';
  const SECTIONS = ['likes', 'favoriteMovies', 'watchedMovies', 'favoriteSeries'];

  /* ---------------- Helpers ---------------- */

  function currentUser() {
    return (typeof authGetCurrentUser === 'function') ? authGetCurrentUser() : null;
  }

  function emptyLibrary() {
    return { likes: [], favoriteMovies: [], watchedMovies: [], favoriteSeries: [] };
  }

  function validSection(section) {
    return SECTIONS.indexOf(section) !== -1;
  }

  function readLibrary(userId) {
    try {
      const raw = localStorage.getItem(LIBRARY_KEY_PREFIX + userId);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        const lib = emptyLibrary();
        SECTIONS.forEach((section) => {
          if (Array.isArray(parsed[section])) lib[section] = parsed[section];
        });
        return lib;
      }
    } catch (err) { /* corrupted / blocked storage — degrade to empty */ }
    return emptyLibrary();
  }

  function writeLibrary(userId, library) {
    try {
      localStorage.setItem(LIBRARY_KEY_PREFIX + userId, JSON.stringify(library));
      return true;
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast('Could not save your library — storage is full or blocked.', 'error');
      }
      return false;
    }
  }

  /** Normalize any incoming item into the compact stored shape. */
  function normalizeItem(item, type) {
    return {
      id: String(item.id),
      title: String(item.title || item.name || 'Untitled'),
      poster: item.poster || item.poster_path || null,
      type: type === 'series' ? 'series' : 'movie',
      addedAt: item.addedAt || Date.now(),
      year: String(item.year || '').trim() || String(item.release_date || item.first_air_date || '').split('-')[0] || ''
    };
  }

  function itemMatches(entry, id, type) {
    return String(entry.id) === String(id) && entry.type === (type === 'series' ? 'series' : 'movie');
  }

  function broadcast(section, action) {
    window.dispatchEvent(new CustomEvent('zeus-library-change', {
      detail: { section: section, action: action }
    }));
  }

  /* ---------------- Public API (window.ZEUSLibrary) ---------------- */

  const ZEUSLibrary = {

    SECTIONS: SECTIONS,

    /** Storage key for a user id (spec: zeus_user_library_<USER_ID>). */
    keyFor: function (userId) {
      return LIBRARY_KEY_PREFIX + userId;
    },

    /** Whether a user is signed in (libraries are per-user). */
    isEnabled: function () {
      return !!currentUser();
    },

    /** Whole library for the current (or given) user. */
    getLibrary: function (userId) {
      const user = userId ? { id: userId } : currentUser();
      if (!user) return emptyLibrary();
      return readLibrary(user.id);
    },

    /** One section's items (newest first) — [] when signed out. */
    getSection: function (section, userId) {
      if (!validSection(section)) return [];
      return this.getLibrary(userId)[section] || [];
    },

    /** Is an id+type already in a section? */
    has: function (section, id, type) {
      if (!validSection(section)) return false;
      const user = currentUser();
      if (!user) return false;
      return readLibrary(user.id)[section].some((entry) => itemMatches(entry, id, type));
    },

    /**
     * Add an item to a section (deduped, newest first).
     * @returns {boolean} true when it was added (false: signed out / duplicate).
     */
    add: function (section, item) {
      if (!validSection(section)) return false;
      const user = currentUser();
      if (!user) return false;
      const entry = normalizeItem(item, item.type);
      const lib = readLibrary(user.id);
      if (lib[section].some((existing) => itemMatches(existing, entry.id, entry.type))) return false;
      lib[section].unshift(entry);
      const ok = writeLibrary(user.id, lib);
      if (ok) broadcast(section, 'add');
      return ok;
    },

    /**
     * Remove an item from a section.
     * @returns {boolean} true when it was removed.
     */
    remove: function (section, id, type) {
      if (!validSection(section)) return false;
      const user = currentUser();
      if (!user) return false;
      const lib = readLibrary(user.id);
      const next = lib[section].filter((entry) => !itemMatches(entry, id, type));
      if (next.length === lib[section].length) return false;
      lib[section] = next;
      const ok = writeLibrary(user.id, lib);
      if (ok) broadcast(section, 'remove');
      return ok;
    },

    /** Empty one section. @returns {boolean} */
    clearSection: function (section) {
      if (!validSection(section)) return false;
      const user = currentUser();
      if (!user) return false;
      const lib = readLibrary(user.id);
      if (!lib[section].length) return false;
      lib[section] = [];
      const ok = writeLibrary(user.id, lib);
      if (ok) broadcast(section, 'clear');
      return ok;
    }
  };

  window.ZEUSLibrary = ZEUSLibrary;

  /* ============================================================
     WATCHLIST MIRRORING (existing site actions, zero file edits)
     watchlist.js declares addToWatchlist / removeFromWatchlist /
     clearWatchlist on window before this script runs. Wrapping the
     globals keeps the original watchlist behavior 100% intact and
     mirrors the outcome into the signed-in user's library:
       heart ON  + movie -> favoriteMovies
       heart ON  + tv    -> favoriteSeries
       heart OFF         -> removed from the matching section
     Internal calls inside watchlist.js (toggleWatchlist) resolve
     the globals at call time, so they hit these wrappers too.
     ============================================================ */

  function mirrorSectionFor(mediaType) {
    return mediaType === 'tv' ? 'favoriteSeries' : 'favoriteMovies';
  }

  function mirrorItem(item) {
    return {
      id: item.id,
      title: item.title || item.name || 'Untitled',
      poster: item.poster_path || item.poster || null,
      year: String(item.release_date || item.first_air_date || '').split('-')[0] || '',
      type: item.media_type === 'tv' ? 'series' : 'movie'
    };
  }

  if (typeof window.addToWatchlist === 'function') {
    const originalAdd = window.addToWatchlist;
    window.addToWatchlist = function (item) {
      const result = originalAdd(item);
      if (result && item) {
        ZEUSLibrary.add(mirrorSectionFor(item.media_type), mirrorItem(item));
      }
      return result;
    };
  }

  if (typeof window.removeFromWatchlist === 'function') {
    const originalRemove = window.removeFromWatchlist;
    window.removeFromWatchlist = function (id, mediaType) {
      const result = originalRemove(id, mediaType);
      if (result) {
        ZEUSLibrary.remove(mirrorSectionFor(mediaType), id, mediaType === 'tv' ? 'series' : 'movie');
      }
      return result;
    };
  }

  if (typeof window.clearWatchlist === 'function') {
    const originalClear = window.clearWatchlist;
    window.clearWatchlist = function () {
      const result = originalClear();
      if (result) {
        ZEUSLibrary.clearSection('favoriteMovies');
        ZEUSLibrary.clearSection('favoriteSeries');
      }
      return result;
    };
  }

  /* ============================================================
     WATCHED MOVIES (automatic, watch.html only)
     When a signed-in user opens the movie playback page with a
     movie selected, it is added to Watched Movies once (deduped).
     No new visible UI — purely automatic tracking.
     ============================================================ */

  function isWatchPage() {
    const file = window.location.pathname.split('/').pop() || '';
    return file === 'watch.html' || !!document.getElementById('player-shell');
  }

  function trackWatchedMovie() {
    const user = currentUser();
    if (!user) return; /* only signed-in users get tracked */
    if (typeof getMovieDetails !== 'function') return;

    const params = new URLSearchParams(window.location.search);
    const type = params.get('type') === 'tv' ? 'tv' : 'movie'; /* same default as watch.js */
    if (type !== 'movie') return; /* movies only */
    const id = params.get('id');
    if (!id || !/^\d+$/.test(String(id))) return;

    getMovieDetails(id).then((data) => {
      if (!data || !data.id) return;
      ZEUSLibrary.add('watchedMovies', {
        id: data.id,
        title: data.title || data.name || 'Untitled',
        poster: data.poster_path || null,
        year: String(data.release_date || '').split('-')[0] || '',
        type: 'movie'
      });
    }).catch(() => { /* TMDB hiccup — tracking is best-effort */ });
  }

  if (isWatchPage()) {
    document.addEventListener('DOMContentLoaded', trackWatchedMovie);
  }

})();
