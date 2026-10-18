/* ============================================================
   ZEUS - settings.js
   Logic for settings.html — the nav pill gear's destination.

   Storage contract (localStorage, single JSON object):
     zeus_settings => {
       quality: 'auto' | '1080p' | '720p' | '480p',
       dataSaver: bool,
       autoplayNext: bool,        // mirrored to the player's real
                                  // 'zeus_autonext_v1' key (watch.js)
       autoplayTrailers: bool,
       buffer: 'low' | 'medium' | 'high',
       subtitles: bool,
       subtitleLanguage: 'english' | ...,
       subtitleSize: 75..175      // percent, live preview + saved,
       audioLanguage: 'original' | ...,
       originalAudio: bool,
       theme: 'dark' | 'dim' | 'amoled',   // applied live via <html data-theme>
       accent: 'gold' | 'crimson' | 'emerald' | 'violet',
       reduceMotion: bool,        // applied live via <html data-reduce-motion>
       notifyNewEpisodes: bool,
       notifyWatchlist: bool,
       notifyParty: bool,
       publicProfile: bool,
       historyVisible: bool
     }

   Everything is local; nothing leaves the browser. Relies on
   api.js ($) and watchlist.js (showToast) being loaded first.
   ============================================================ */

'use strict';

(function () {

  const SETTINGS_KEY = 'zeus_settings';
  const AUTO_NEXT_PLAYER_KEY = 'zeus_autonext_v1'; // real key the watch player reads
  const LIBRARY_KEY_PREFIX = 'zeus_user_library_';

  const DEFAULTS = {
    quality: 'auto',
    dataSaver: false,
    autoplayNext: false,
    autoplayTrailers: true,
    buffer: 'medium',
    subtitles: true,
    subtitleLanguage: 'english',
    subtitleSize: 100,
    audioLanguage: 'original',
    originalAudio: true,
    theme: 'dark',
    accent: 'gold',
    reduceMotion: false,
    notifyNewEpisodes: true,
    notifyWatchlist: true,
    notifyParty: true,
    publicProfile: false,
    historyVisible: true
  };

  /* ---------------- helpers ---------------- */

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type || 'success');
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const merged = {};
      Object.keys(DEFAULTS).forEach((key) => {
        merged[key] = (parsed && parsed[key] !== undefined) ? parsed[key] : DEFAULTS[key];
      });
      return merged;
    } catch (err) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return true;
    } catch (err) {
      toast('Could not save — storage is full or blocked.', 'error');
      return false;
    }
  }

  /* ---------------- live application ---------------- */

  function applySettings(settings) {
    const root = document.documentElement;

    /* theme */
    if (settings.theme && settings.theme !== 'dark') {
      root.setAttribute('data-theme', settings.theme);
    } else {
      root.removeAttribute('data-theme');
    }

    /* accent colour */
    if (settings.accent && settings.accent !== 'gold') {
      root.setAttribute('data-accent', settings.accent);
    } else {
      root.removeAttribute('data-accent');
    }

    /* reduce motion */
    if (settings.reduceMotion) {
      root.setAttribute('data-reduce-motion', '1');
    } else {
      root.removeAttribute('data-reduce-motion');
    }

    /* subtitle size (live preview) */
    root.style.setProperty('--zeus-sub-size', String(settings.subtitleSize / 100));
    const sizeLabel = document.getElementById('sub-size-label');
    if (sizeLabel) sizeLabel.textContent = settings.subtitleSize + '%';

    /* autoplay next — mirrored into the key the player reads,
       so this toggle genuinely drives watch.html's AutoNext. */
    try {
      localStorage.setItem(AUTO_NEXT_PLAYER_KEY, settings.autoplayNext ? '1' : '0');
    } catch (err) { /* storage blocked — the UI toggle still persists */ }
  }

  /* ---------------- control binding ---------------- */

  function bindControls(settings) {
    /* checkboxes */
    document.querySelectorAll('[data-setting]').forEach((input) => {
      if (input.type !== 'checkbox') return;
      input.checked = !!settings[input.dataset.setting];
      input.addEventListener('change', () => {
        settings[input.dataset.setting] = input.checked;
        saveSettings(settings);
        applySettings(settings);
      });
    });

    /* segmented radio groups + swatches (grouped by name) */
    document.querySelectorAll('.zeus-segment[data-setting], .zeus-swatches[data-setting]').forEach((group) => {
      const key = group.dataset.setting;
      const radios = group.querySelectorAll('input[type="radio"]');
      radios.forEach((radio) => {
        radio.checked = radio.value === String(settings[key]);
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          settings[key] = radio.value;
          saveSettings(settings);
          applySettings(settings);
        });
      });
    });

    /* selects */
    document.querySelectorAll('select[data-setting]').forEach((select) => {
      select.value = settings[select.dataset.setting];
      select.addEventListener('change', () => {
        settings[select.dataset.setting] = select.value;
        saveSettings(settings);
        applySettings(settings);
      });
    });

    /* range slider — save on release, live preview while dragging */
    const range = document.querySelector('.zeus-range[data-setting]');
    if (range) {
      range.value = settings[range.dataset.setting];
      range.addEventListener('input', () => {
        settings[range.dataset.setting] = Number(range.value);
        applySettings(settings); /* instant preview, not saved yet */
      });
      range.addEventListener('change', () => {
        settings[range.dataset.setting] = Number(range.value);
        saveSettings(settings);
      });
    }
  }

  /* ---------------- account card ---------------- */

  function esc(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function renderAccountCard() {
    const row = document.getElementById('account-row');
    const status = document.getElementById('account-status');
    if (!row || !status) return;

    let user = null;
    if (typeof authGetCurrentUser === 'function') {
      user = authGetCurrentUser();
    }

    if (user && user.email) {
      status.textContent = 'Signed in with a local account';
      row.innerHTML =
        '<span class="settings-account-email">' + esc(user.email) + '</span>' +
        '<a class="btn btn-primary settings-account-link" href="account.html">Account</a>' +
        '<button class="btn btn-outline" id="settings-signout" type="button">Sign out</button>';
      const signOut = document.getElementById('settings-signout');
      if (signOut) {
        signOut.addEventListener('click', () => {
          if (typeof authSignOut === 'function') authSignOut();
          renderAccountCard();
          renderDeviceList();
          toast('Signed out.');
        });
      }
    } else {
      status.textContent = 'Browsing without a local account';
      row.innerHTML =
        '<span class="settings-account-note">A local account keeps your watchlist, library and settings in this browser — nothing is ever uploaded.</span>' +
        '<a class="btn btn-primary settings-account-link" href="login.html">Sign in / Create account</a>';
    }
  }

  /* ---------------- devices card ---------------- */

  function renderDeviceList() {
    const list = document.getElementById('device-list');
    if (!list) return;

    let user = null;
    if (typeof authGetCurrentUser === 'function') {
      user = authGetCurrentUser();
    }

    const items = [
      {
        icon: '<svg viewBox="0 0 24 24"><path d="M20 18c1.1 0 2-.9 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>',
        name: 'This browser',
        sub: user && user.email
          ? 'Local session · ' + esc(user.email)
          : 'No local session — settings are stored anonymously',
        badge: 'Active now'
      }
    ];

    list.innerHTML = items.map(function (item) {
      return (
        '<li class="device-item">' +
          item.icon +
          '<div class="device-item-meta">' +
            '<p class="device-item-name">' + item.name + '</p>' +
            '<p class="device-item-sub">' + item.sub + '</p>' +
          '</div>' +
          '<span class="device-item-badge">' + item.badge + '</span>' +
        '</li>'
      );
    }).join('') +
    '<li class="device-item"><div class="device-item-meta">' +
      '<p class="device-item-sub">ZEUS local accounts live only in this browser — there are no remote sessions to review or revoke.</p>' +
    '</div></li>';
  }

  /* ---------------- privacy actions ---------------- */

  function clearWatchHistory() {
    let cleared = 0;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.indexOf(LIBRARY_KEY_PREFIX) === 0) keys.push(key);
      }
      keys.forEach((key) => {
        try {
          const raw = localStorage.getItem(key);
          const lib = raw ? JSON.parse(raw) : null;
          if (lib && typeof lib === 'object') {
            lib.watchedMovies = [];
            localStorage.setItem(key, JSON.stringify(lib));
            cleared++;
          }
        } catch (err) { /* skip corrupted entry */ }
      });
      toast('Watch history cleared' + (cleared ? ' (' + cleared + ' profile' + (cleared === 1 ? '' : 's') + ')' : '') + '.');
    } catch (err) {
      toast('Could not clear history — storage is blocked.', 'error');
    }
  }

  function signOutAllDevices() {
    try {
      if (typeof authSignOut === 'function') authSignOut();
      renderAccountCard();
      renderDeviceList();
      toast('Signed out of all devices.');
    } catch (err) {
      toast('Could not sign out — storage is blocked.', 'error');
    }
  }

  /* ---------------- boot ---------------- */

  function init() {
    const settings = loadSettings();
    applySettings(settings);
    bindControls(settings);
    renderAccountCard();
    renderDeviceList();

    const clearBtn = document.getElementById('clear-history');
    if (clearBtn) clearBtn.addEventListener('click', clearWatchHistory);

    const signOutAllBtn = document.getElementById('sign-out-all');
    if (signOutAllBtn) signOutAllBtn.addEventListener('click', signOutAllDevices);

    /* keep the account card fresh if auth changes elsewhere */
    window.addEventListener('zeus-auth-change', () => {
      renderAccountCard();
      renderDeviceList();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
