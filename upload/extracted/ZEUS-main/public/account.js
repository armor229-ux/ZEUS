/* ============================================================
   ZEUS - account.js
   Account dashboard page: profile header (email, member since,
   log out) + the four per-user library sections — Likes,
   Favorite Movies, Watched Movies, Favorite Series — each with
   a count, poster rows and a per-item Remove action.
   Depends on auth.js (auth state) + library.js (ZEUSLibrary)
   + api.js (imageUrl / escapeHtml / POSTER_SIZE).
   ============================================================ */

'use strict';

(function () {

  /* ---------------- Section configuration ---------------- */
  const SECTIONS = [
    {
      key: 'likes',
      list: 'account-likes-list',
      count: 'account-likes-count',
      empty: 'No likes yet — titles you like will appear here.',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
    },
    {
      key: 'favoriteMovies',
      list: 'account-favmovies-list',
      count: 'account-favmovies-count',
      empty: 'No favorite movies yet — tap the heart on any movie to save it here.',
      icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 10h4M17 10h4M3 14h4M17 14h4"/></svg>'
    },
    {
      key: 'watchedMovies',
      list: 'account-watched-list',
      count: 'account-watched-count',
      empty: 'No watched movies yet — movies you open on the watch page will be tracked here.',
      icon: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
    },
    {
      key: 'favoriteSeries',
      list: 'account-favseries-list',
      count: 'account-favseries-count',
      empty: 'No favorite series yet — tap the heart on any TV show to save it here.',
      icon: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 3l4 4 4-4"/></svg>'
    }
  ];

  const TRASH_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

  /* ---------------- Elements ---------------- */
  const signedOutCard = document.getElementById('account-signedout');
  const profileCard = document.getElementById('account-profile');
  const sectionsWrap = document.getElementById('account-sections');
  const avatarEl = document.getElementById('account-avatar');
  const emailEl = document.getElementById('account-email');
  const memberSinceEl = document.getElementById('account-member-since');
  const logoutBtn = document.getElementById('account-logout-btn');

  /* ---------------- Helpers ---------------- */

  function esc(text) {
    return typeof escapeHtml === 'function' ? escapeHtml(text) : String(text);
  }

  function detailHref(item) {
    return (item.type === 'series' ? 'tv.html?id=' : 'movie.html?id=') + encodeURIComponent(item.id);
  }

  function posterSrc(item) {
    if (typeof imageUrl === 'function') return imageUrl(item.poster, POSTER_SIZE);
    return item.poster || '';
  }

  /* ---------------- Item rows ---------------- */

  function createItemRow(sectionKey, item) {
    const row = document.createElement('div');
    row.className = 'account-item';
    const typeLabel = item.type === 'series' ? 'Series' : 'Movie';
    const year = item.year ? '<span>' + esc(item.year) + '</span>' : '';
    row.innerHTML =
      '<a class="account-item-poster" href="' + detailHref(item) + '" tabindex="-1" aria-hidden="true">' +
        '<img src="' + esc(posterSrc(item)) + '" alt="" loading="lazy" decoding="async" data-fallback="poster" onerror="handleImageError(this)">' +
      '</a>' +
      '<div class="account-item-info">' +
        '<a class="account-item-title" href="' + detailHref(item) + '" title="' + esc(item.title) + '">' + esc(item.title) + '</a>' +
        '<p class="account-item-meta">' +
          year +
          '<span class="account-item-type">' + typeLabel + '</span>' +
        '</p>' +
      '</div>' +
      '<button class="account-item-remove" type="button" data-section="' + sectionKey + '"' +
      ' data-id="' + esc(item.id) + '" data-type="' + esc(item.type) + '" data-title="' + esc(item.title) + '"' +
      ' aria-label="Remove ' + esc(item.title) + ' from this list">' +
        TRASH_SVG + '<span>Remove</span>' +
      '</button>';
    return row;
  }

  function createEmptyState(message, icon) {
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.innerHTML = icon + '<p>' + esc(message) + '</p>';
    return empty;
  }

  /* ---------------- Rendering ---------------- */

  function renderSection(section) {
    const listEl = document.getElementById(section.list);
    const countEl = document.getElementById(section.count);
    if (!listEl || !countEl) return;

    const items = (typeof ZEUSLibrary === 'function' || typeof ZEUSLibrary === 'object') && ZEUSLibrary
      ? ZEUSLibrary.getSection(section.key)
      : [];

    countEl.textContent = '(' + items.length + ')';
    countEl.classList.toggle('is-empty', items.length === 0);

    listEl.innerHTML = '';
    listEl.classList.remove('has-items');
    if (!items.length) {
      listEl.appendChild(createEmptyState(section.empty, section.icon));
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createItemRow(section.key, item)));
    listEl.appendChild(fragment);
    listEl.classList.add('has-items');
  }

  function render() {
    const current = (typeof authGetCurrentUser === 'function') ? authGetCurrentUser() : null;

    if (!current) {
      /* Not signed in: show the notice and bounce to the login page. */
      if (signedOutCard) signedOutCard.hidden = false;
      if (profileCard) profileCard.hidden = true;
      if (sectionsWrap) sectionsWrap.hidden = true;
      window.location.replace('login.html');
      return;
    }

    if (signedOutCard) signedOutCard.hidden = true;
    if (profileCard) profileCard.hidden = false;
    if (sectionsWrap) sectionsWrap.hidden = false;

    if (avatarEl) {
      const first = String(current.email || '').trim().charAt(0);
      avatarEl.textContent = first ? first.toUpperCase() : 'Z';
    }
    if (emailEl) emailEl.textContent = current.email;

    if (memberSinceEl) {
      const record = (typeof authGetUsers === 'function')
        ? authGetUsers().find((u) => u.id === current.id)
        : null;
      if (record && record.createdAt) {
        const created = new Date(record.createdAt);
        memberSinceEl.innerHTML =
          '<span class="account-since">Member since ' +
          esc(created.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })) +
          '</span> — local account, stored in this browser only';
      } else {
        memberSinceEl.textContent = 'Local account — stored in this browser only';
      }
    }

    SECTIONS.forEach(renderSection);
  }

  /* ---------------- Remove action ---------------- */

  function handleRemoveClick(event) {
    const btn = event.target.closest('.account-item-remove');
    if (!btn) return;
    event.preventDefault();

    const sectionKey = btn.dataset.section;
    const id = btn.dataset.id;
    const type = btn.dataset.type;
    const title = btn.dataset.title || 'This title';
    if (!sectionKey || !id || !type) return;
    if (typeof ZEUSLibrary === 'undefined' || !ZEUSLibrary) return;

    const removed = ZEUSLibrary.remove(sectionKey, id, type);

    /* Keep the site watchlist hearts in sync with the Favorites
       sections (mirrored on add by library.js). */
    if (removed && (sectionKey === 'favoriteMovies' || sectionKey === 'favoriteSeries')) {
      if (typeof removeFromWatchlist === 'function') {
        removeFromWatchlist(id, type === 'series' ? 'tv' : 'movie');
      }
    }

    if (removed) {
      if (typeof showToast === 'function') showToast('Removed "' + title + '" from your library.', 'info');
      renderSection(SECTIONS.find((s) => s.key === sectionKey));
    }
  }

  /* ---------------- Log out ---------------- */

  function handleLogout() {
    if (typeof authSignOut === 'function') authSignOut();
    if (typeof showToast === 'function') showToast('You have been signed out', 'info');
    window.setTimeout(() => { window.location.href = 'login.html'; }, 400);
  }

  /* ---------------- Wiring ---------------- */

  SECTIONS.forEach((section) => {
    const listEl = document.getElementById(section.list);
    if (listEl) listEl.addEventListener('click', handleRemoveClick);
  });
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  /* Live updates: in-page library writes + other tabs + auth changes */
  window.addEventListener('zeus-library-change', () => {
    if (authGetCurrentUser()) SECTIONS.forEach(renderSection);
  });
  window.addEventListener('storage', (event) => {
    if (!event.key) return;
    if (event.key.indexOf('zeus_user_library_') === 0 || event.key === 'zeus_current_user') {
      render();
    }
  });
  window.addEventListener('zeus-auth-change', (event) => {
    if (!event.detail || !event.detail.user) {
      window.location.replace('login.html'); /* signed out — leave the account page */
    } else {
      render();
    }
  });

  /* Common UI (page loader, navbar, hamburger, disclaimer banner,
     back-to-top, footer year) — every ZEUS page script calls this
     at DOMContentLoaded (same pattern as legal.js / login.js). */
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof initCommonUI === 'function') initCommonUI();
  });

  /* ---------------- Init ---------------- */
  render();

})();
