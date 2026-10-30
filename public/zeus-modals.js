/* ============================================================
   ZEUS — zeus-modals.js  (v1.0)
   ------------------------------------------------------------
   GOLD UPDATE (Task 9): Login & Settings open premium POPUP
   CARDS on the current page instead of navigating away.

   INTERCEPTOR — any in-site <a> whose href resolves to
   login.html / settings.html (header Login & Settings buttons,
   footer links, in-page links) is prevented from navigating and
   opens the matching modal instead. The routes themselves stay
   untouched and reachable by direct URL (board rule: "do NOT
   change routes if they already exist; stop Login/Settings from
   navigating away").

   MODAL ENGINE — centered glass cards (CSS section 40), 220ms
   in/out, ESC closes, outside-click closes, × closes, focus
   trap, body scroll lock while open, focus returns to the
   trigger on close.

   LOGIN MODAL — Email + Password + Remember me + Sign In
   (real local auth via auth.js), Forgot password (inline info —
   local accounts have no email reset), Create account ↔ Sign in
   mode swap (authSignUp), and a signed-in state with Sign out.
   Remember me UNCHECKED = the session ends when you leave the
   page: a 'zeus_signout_on_exit' flag is honored on the next
   page load (local-only semantics; auth.js itself is untouched).

   SETTINGS MODAL — the full settings page inside the card:
   Playback, Subtitles & Audio, Appearance, Notifications,
   Privacy, Devices — same 'zeus_settings' localStorage contract
   as settings.js, applied LIVE (theme / accent / reduceMotion /
   subtitle size / AutoNext mirror). settings.css is injected on
   pages that don't already load it, so the controls look
   byte-identical to the settings page. On settings.html the
   modal also syncs the page controls behind it.

   Loaded on the 13 topbar pages (party.html has no topbar).
   Depends on: auth.js (guarded — degrades with an inline
   message), subtitle-prefs.js / window.ZEUS.subtitles (guarded —
   those controls stay inert exactly like settings.js), and
   watchlist.js showToast (guarded).
   ============================================================ */

(function () {
  'use strict';

  /* ============ 0. settings.css injection (control parity) ============ */

  if (!document.querySelector('link[href*="settings.css"]')) {
    var sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = 'settings.css?v=1.0';
    document.head.appendChild(sheet);
  }

  /* ============ 1. remember-me session flag (honor at load) ============ */

  try {
    if (localStorage.getItem('zeus_signout_on_exit') === '1') {
      localStorage.removeItem('zeus_signout_on_exit');
      if (typeof authSignOut === 'function') authSignOut();
    }
  } catch (e) { /* storage blocked — nothing to honor */ }

  /* ============ 2. DOM templates ============ */

  var LOGIN_HTML = ''
    + '<div class="zeus-modal zeus-glass" role="dialog" aria-modal="true" aria-labelledby="zeus-login-title">'
    +   '<button class="zeus-modal-close" type="button" aria-label="Close">\u00d7</button>'
    +   '<h2 class="zeus-modal-title" id="zeus-login-title">Login</h2>'
    +   '<p class="zeus-modal-sub">Local account — stored in this browser only, nothing is uploaded.</p>'

    +   '<div class="zeus-login-signedin" hidden>'
    +     '<div class="zeus-login-avatar" aria-hidden="true">Z</div>'
    +     '<div class="zeus-login-signedin-meta">'
    +       '<p class="zeus-login-signedin-email"></p>'
    +       '<p class="zeus-login-signedin-note">You&#39;re signed in with a local account.</p>'
    +     '</div>'
    +     '<button class="btn btn-outline zeus-login-signout" type="button">Sign out</button>'
    +   '</div>'

    +   '<form class="zeus-login-form" id="zeus-login-signin" novalidate>'
    +     '<label class="zeus-field">'
    +       '<span class="zeus-field-label">Email</span>'
    +       '<input class="zeus-input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required>'
    +     '</label>'
    +     '<label class="zeus-field">'
    +       '<span class="zeus-field-label">Password</span>'
    +       '<input class="zeus-input" type="password" name="password" autocomplete="current-password" placeholder="Your password" required>'
    +     '</label>'
    +     '<label class="zeus-remember"><input type="checkbox" checked> Remember me</label>'
    +     '<button type="submit" class="zeus-login-submit">Sign In</button>'
    +     '<div class="zeus-login-links">'
    +       '<a href="#" class="zeus-forgot-link">Forgot password?</a>'
    +     '</div>'
    +     '<p class="zeus-login-message" role="status" aria-live="polite"></p>'
    +   '</form>'

    +   '<form class="zeus-login-form" id="zeus-login-signup" hidden novalidate>'
    +     '<label class="zeus-field">'
    +       '<span class="zeus-field-label">Email</span>'
    +       '<input class="zeus-input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required>'
    +     '</label>'
    +     '<label class="zeus-field">'
    +       '<span class="zeus-field-label">Password (minimum 8 characters)</span>'
    +       '<input class="zeus-input" type="password" name="password" autocomplete="new-password" placeholder="Create a password" required>'
    +     '</label>'
    +     '<button type="submit" class="zeus-login-submit">Create Account</button>'
    +     '<div class="zeus-login-links">'
    +       '<a href="#" class="zeus-back-link">Back to sign in</a>'
    +     '</div>'
    +     '<p class="zeus-login-message" role="status" aria-live="polite"></p>'
    +   '</form>'

    +   '<div class="zeus-login-alt">New to ZEUS? <a href="#" class="zeus-signup-link">Create account</a></div>'
    + '</div>';

  var SETTINGS_HTML = ''
    + '<div class="zeus-modal zeus-modal-settings zeus-glass" role="dialog" aria-modal="true" aria-labelledby="zeus-settings-title">'
    +   '<button class="zeus-modal-close" type="button" aria-label="Close">\u00d7</button>'
    +   '<h2 class="zeus-modal-title" id="zeus-settings-title">Settings</h2>'
    +   '<p class="zeus-modal-sub">Your preferences are saved to this browser instantly — no account required.</p>'
    +   '<div class="settings-grid">'

    +     '<section class="zeus-glass settings-card" aria-labelledby="zm-set-playback-title">'
    +       '<header class="settings-card-head">'
    +         '<span class="settings-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>'
    +         '<div><h2 class="settings-card-title" id="zm-set-playback-title">Playback</h2>'
    +         '<p class="settings-card-sub">Quality and streaming behaviour</p></div>'
    +       '</header>'
    +       '<div class="settings-card-body">'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Default quality</span>'
    +           '<span class="settings-row-hint">Applied when a new stream starts</span></div>'
    +           '<div class="zeus-segment" role="radiogroup" aria-label="Default quality" data-setting="quality">'
    +             '<label><input type="radio" name="zm-quality" value="auto"><span>Auto</span></label>'
    +             '<label><input type="radio" name="zm-quality" value="1080p"><span>1080p</span></label>'
    +             '<label><input type="radio" name="zm-quality" value="720p"><span>720p</span></label>'
    +             '<label><input type="radio" name="zm-quality" value="480p"><span>480p</span></label>'
    +           '</div>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Data saver</span>'
    +           '<span class="settings-row-hint">Prefer lower bitrates on metered connections</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="dataSaver"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Autoplay next episode</span>'
    +           '<span class="settings-row-hint">Also drives the player&#39;s AutoNext switch</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="autoplayNext"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Autoplay trailers</span>'
    +           '<span class="settings-row-hint">Play trailers when browsing details</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="autoplayTrailers"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Buffer</span>'
    +           '<span class="settings-row-hint">Higher = smoother playback, slower start</span></div>'
    +           '<div class="zeus-segment" role="radiogroup" aria-label="Buffer" data-setting="buffer">'
    +             '<label><input type="radio" name="zm-buffer" value="low"><span>Low</span></label>'
    +             '<label><input type="radio" name="zm-buffer" value="medium"><span>Medium</span></label>'
    +             '<label><input type="radio" name="zm-buffer" value="high"><span>High</span></label>'
    +           '</div>'
    +         '</div>'
    +       '</div>'
    +     '</section>'

    +     '<section class="zeus-glass settings-card" aria-labelledby="zm-set-subs-title">'
    +       '<header class="settings-card-head">'
    +         '<span class="settings-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm6 0h10v2H10v-2zM4 8h9v2H4V8zm11 0h5v2h-5V8z"/></svg></span>'
    +         '<div><h2 class="settings-card-title" id="zm-set-subs-title">Subtitles &amp; Audio</h2>'
    +         '<p class="settings-card-sub">Captions and language preferences</p></div>'
    +       '</header>'
    +       '<div class="settings-card-body">'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Subtitles</span>'
    +           '<span class="settings-row-hint">Show captions when available</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="subtitles"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Subtitle language</span></div>'
    +           '<select class="zeus-select" data-setting="subtitleLanguage" aria-label="Subtitle language">'
    +             '<option value="english">English</option><option value="spanish">Spanish</option>'
    +             '<option value="french">French</option><option value="german">German</option>'
    +             '<option value="arabic">Arabic</option><option value="japanese">Japanese</option>'
    +           '</select>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Preferred subtitle language</span>'
    +           '<span class="settings-row-hint">Auto-selects matching tracks when a video plays</span></div>'
    +           '<select class="zeus-select" id="zm-sub-pref-select" aria-label="Preferred subtitle language">'
    +             '<option value="">Default (no auto-selection)</option>'
    +             '<option value="ar">Arabic (ar)</option><option value="en">English (en)</option>'
    +             '<option value="tr">Turkish (tr)</option><option value="es">Spanish (es)</option>'
    +             '<option value="fr">French (fr)</option><option value="de">German (de)</option>'
    +           '</select>'
    +         '</div>'
    +         '<div class="settings-row settings-row--column">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Subtitle size</span>'
    +           '<span class="settings-row-hint" id="zm-sub-size-label">100%</span></div>'
    +           '<input type="range" class="zeus-range" min="75" max="175" step="5" value="100" data-setting="subtitleSize" aria-label="Subtitle size">'
    +           '<div class="sub-preview" aria-hidden="true"><p class="sub-preview-text" id="zm-sub-preview-text">"The storm is coming."</p></div>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Subtitle colour</span>'
    +           '<span class="settings-row-hint">Applies instantly to video captions</span></div>'
    +           '<div class="zeus-swatches" role="radiogroup" aria-label="Subtitle colour">'
    +             '<label class="zeus-swatch zeus-swatch--sub-white" title="White"><input type="radio" name="zm-sub-color" value="#ffffff"><span aria-hidden="true"></span><span class="sr-only">White</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--sub-yellow" title="Yellow"><input type="radio" name="zm-sub-color" value="#ffd54a"><span aria-hidden="true"></span><span class="sr-only">Yellow</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--sub-sky" title="Sky blue"><input type="radio" name="zm-sub-color" value="#76e4ff"><span aria-hidden="true"></span><span class="sr-only">Sky blue</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--sub-green" title="Green"><input type="radio" name="zm-sub-color" value="#8aff7d"><span aria-hidden="true"></span><span class="sr-only">Green</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--sub-pink" title="Pink"><input type="radio" name="zm-sub-color" value="#ff79c6"><span aria-hidden="true"></span><span class="sr-only">Pink</span></label>'
    +             '<label class="zeus-subcolor-custom" title="Custom colour"><input type="color" id="zm-sub-color-custom" value="#ffffff" aria-label="Custom subtitle colour"></label>'
    +           '</div>'
    +         '</div>'
    +         '<div class="settings-row settings-row--column">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Subtitle timing</span>'
    +           '<span class="settings-row-hint"><span id="zm-sub-offset-label">0s</span> · negative shows captions earlier, positive later</span></div>'
    +           '<div class="sub-offset-controls">'
    +             '<input type="range" class="zeus-range" id="zm-sub-offset-range" min="-5000" max="5000" step="100" value="0" aria-label="Subtitle timing offset in milliseconds">'
    +             '<button class="btn btn-outline settings-danger-btn" id="zm-sub-offset-reset" type="button">Reset</button>'
    +           '</div>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Audio track language</span></div>'
    +           '<select class="zeus-select" data-setting="audioLanguage" aria-label="Audio track language">'
    +             '<option value="original">Original</option><option value="english">English</option>'
    +             '<option value="spanish">Spanish</option><option value="french">French</option>'
    +             '<option value="german">German</option><option value="arabic">Arabic</option>'
    +             '<option value="japanese">Japanese</option>'
    +           '</select>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Always original audio</span>'
    +           '<span class="settings-row-hint">Never dub, regardless of language</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="originalAudio"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +       '</div>'
    +     '</section>'

    +     '<section class="zeus-glass settings-card" aria-labelledby="zm-set-look-title">'
    +       '<header class="settings-card-head">'
    +         '<span class="settings-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg></span>'
    +         '<div><h2 class="settings-card-title" id="zm-set-look-title">Appearance</h2>'
    +         '<p class="settings-card-sub">Theme and motion — applies instantly</p></div>'
    +       '</header>'
    +       '<div class="settings-card-body">'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Theme</span></div>'
    +           '<div class="zeus-segment" role="radiogroup" aria-label="Theme" data-setting="theme">'
    +             '<label><input type="radio" name="zm-theme" value="dark"><span>Dark</span></label>'
    +             '<label><input type="radio" name="zm-theme" value="dim"><span>Dim</span></label>'
    +             '<label><input type="radio" name="zm-theme" value="amoled"><span>AMOLED</span></label>'
    +           '</div>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Accent colour</span>'
    +           '<span class="settings-row-hint">Used for highlights and controls</span></div>'
    +           '<div class="zeus-swatches" role="radiogroup" aria-label="Accent colour" data-setting="accent">'
    +             '<label class="zeus-swatch zeus-swatch--gold" title="Zeus Gold"><input type="radio" name="zm-accent" value="gold"><span aria-hidden="true"></span><span class="sr-only">Zeus Gold</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--crimson" title="Crimson"><input type="radio" name="zm-accent" value="crimson"><span aria-hidden="true"></span><span class="sr-only">Crimson</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--emerald" title="Emerald"><input type="radio" name="zm-accent" value="emerald"><span aria-hidden="true"></span><span class="sr-only">Emerald</span></label>'
    +             '<label class="zeus-swatch zeus-swatch--violet" title="Violet"><input type="radio" name="zm-accent" value="violet"><span aria-hidden="true"></span><span class="sr-only">Violet</span></label>'
    +           '</div>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Reduce motion</span>'
    +           '<span class="settings-row-hint">Minimise animations site-wide</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="reduceMotion"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +       '</div>'
    +     '</section>'

    +     '<section class="zeus-glass settings-card" aria-labelledby="zm-set-notify-title">'
    +       '<header class="settings-card-head">'
    +         '<span class="settings-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 22a2.1 2.1 0 0 0 2.1-2h-4.2A2.1 2.1 0 0 0 12 22zm7-5v-5a7 7 0 0 0-5.6-6.8V4.5a1.4 1.4 0 0 0-2.8 0v.7A7 7 0 0 0 5 12v5l-2 2v1h18v-1l-2-2z"/></svg></span>'
    +         '<div><h2 class="settings-card-title" id="zm-set-notify-title">Notifications</h2>'
    +         '<p class="settings-card-sub">Reminders ZEUS can surface in this browser</p></div>'
    +       '</header>'
    +       '<div class="settings-card-body">'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">New episode alerts</span>'
    +           '<span class="settings-row-hint">Shows you follow get new episodes</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="notifyNewEpisodes"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Watchlist reminders</span>'
    +           '<span class="settings-row-hint">Nudges for titles saved a while ago</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="notifyWatchlist"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Watch Party invites</span>'
    +           '<span class="settings-row-hint">Friends starting a synced room</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="notifyParty"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +       '</div>'
    +     '</section>'

    +     '<section class="zeus-glass settings-card" aria-labelledby="zm-set-privacy-title">'
    +       '<header class="settings-card-head">'
    +         '<span class="settings-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-9-2a3 3 0 0 1 6 0v2H9V6zm3 11a2 2 0 1 1 2-2 2 2 0 0 1-2 2z"/></svg></span>'
    +         '<div><h2 class="settings-card-title" id="zm-set-privacy-title">Privacy</h2>'
    +         '<p class="settings-card-sub">Everything is local — nothing leaves this browser</p></div>'
    +       '</header>'
    +       '<div class="settings-card-body">'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Public profile</span>'
    +           '<span class="settings-row-hint">Share your display name on Party invites</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="publicProfile"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Watch history visible</span>'
    +           '<span class="settings-row-hint">Show "Continue watching" hints</span></div>'
    +           '<label class="zeus-switch"><input type="checkbox" data-setting="historyVisible"><span class="zeus-switch-track" aria-hidden="true"></span></label>'
    +         '</div>'
    +         '<div class="settings-row">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Watch history</span>'
    +           '<span class="settings-row-hint">Clears tracked watched titles (likes and favourites are kept)</span></div>'
    +           '<button class="btn btn-outline settings-danger-btn" id="zm-clear-history" type="button">Clear watch history</button>'
    +         '</div>'
    +       '</div>'
    +     '</section>'

    +     '<section class="zeus-glass settings-card" aria-labelledby="zm-set-devices-title">'
    +       '<header class="settings-card-head">'
    +         '<span class="settings-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h18V4H4a2 2 0 0 0-2 2v11H0v3h14v-3H4V6zm17 2h-3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1z"/></svg></span>'
    +         '<div><h2 class="settings-card-title" id="zm-set-devices-title">Devices</h2>'
    +         '<p class="settings-card-sub">Sessions on this local account</p></div>'
    +       '</header>'
    +       '<div class="settings-card-body">'
    +         '<ul class="device-list" id="zm-device-list"></ul>'
    +         '<div class="settings-row settings-row--last">'
    +           '<div class="settings-row-label"><span class="settings-row-name">Sign out of all devices</span>'
    +           '<span class="settings-row-hint">Ends the local sign-in everywhere</span></div>'
    +           '<button class="btn btn-outline settings-danger-btn" id="zm-sign-out-all" type="button">Sign out all</button>'
    +         '</div>'
    +       '</div>'
    +     '</section>'

    +   '</div>'
    + '</div>';

  /* ============ 3. modal engine ============ */

  var loginBackdrop = null, settingsBackdrop = null;
  var loginCard = null, settingsCard = null;
  var lastFocus = null;
  var CLOSE_MS = 210;
  var closeTimer = null;

  function build() {
    if (loginBackdrop && settingsBackdrop) return;

    loginBackdrop = document.createElement('div');
    loginBackdrop.className = 'zeus-modal-backdrop';
    loginBackdrop.id = 'zeus-login-modal';
    loginBackdrop.hidden = true;
    loginBackdrop.innerHTML = LOGIN_HTML;
    document.body.appendChild(loginBackdrop);
    loginCard = loginBackdrop.querySelector('.zeus-modal');

    settingsBackdrop = document.createElement('div');
    settingsBackdrop.className = 'zeus-modal-backdrop';
    settingsBackdrop.id = 'zeus-settings-modal';
    settingsBackdrop.hidden = true;
    settingsBackdrop.innerHTML = SETTINGS_HTML;
    document.body.appendChild(settingsBackdrop);
    settingsCard = settingsBackdrop.querySelector('.zeus-modal');

    [loginBackdrop, settingsBackdrop].forEach(function (b) {
      b.addEventListener('click', function (e) {
        if (e.target === b) hideModal(b);      /* outside click */
      });
      b.querySelector('.zeus-modal-close').addEventListener('click', function () {
        hideModal(b);
      });
    });

    bindLogin();
    bindSettings();
  }

  function openBackdrop(b) {
    /* if another modal is open, hide it instantly (no animation) */
    [loginBackdrop, settingsBackdrop].forEach(function (o) {
      if (o !== b && o && !o.hidden) hideNow(o);
    });
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    lastFocus = document.activeElement;
    b.hidden = false;
    b.classList.remove('zeus-modal-closing');
    b.classList.add('zeus-modal-open');
    document.body.classList.add('zeus-modal-lock');
  }

  function hideNow(b) {
    b.classList.remove('zeus-modal-open', 'zeus-modal-closing');
    b.hidden = true;
  }

  function hideModal(b) {
    if (b.hidden || b.classList.contains('zeus-modal-closing')) return;
    b.classList.add('zeus-modal-closing');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      closeTimer = null;
      hideNow(b);
      if (!loginBackdrop.classList.contains('zeus-modal-open') &&
          !settingsBackdrop.classList.contains('zeus-modal-open')) {
        document.body.classList.remove('zeus-modal-lock');
      }
      if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (e) { /* detached */ }
      }
      lastFocus = null;
    }, CLOSE_MS);
  }

  function openLogin() {
    build();
    renderLoginState();
    openBackdrop(loginBackdrop);
    var email = loginCard.querySelector('#zeus-login-signin input[type="email"]');
    if (!loginCard.querySelector('.zeus-login-signedin').hidden) {
      loginCard.querySelector('.zeus-modal-close').focus();
    } else if (email) {
      email.focus();
    }
  }

  function openSettings() {
    build();
    syncSettingsControls();
    openBackdrop(settingsBackdrop);
    settingsCard.querySelector('.zeus-modal-close').focus();
  }

  /* ESC + focus trap (single open modal at a time) */
  document.addEventListener('keydown', function (e) {
    var open = document.querySelector('.zeus-modal-backdrop.zeus-modal-open');
    if (!open || open.classList.contains('zeus-modal-closing')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      hideModal(open);
      return;
    }
    if (e.key !== 'Tab') return;

    var focusables = Array.prototype.filter.call(
      open.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null; }   /* skip hidden forms */
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    } else if (document.activeElement === document.body) {
      e.preventDefault(); first.focus();
    }
  });

  /* ============ 4. link interceptor (Login / Settings never navigate) ============ */

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;

    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;   /* in-modal anchors handled locally */

    var url;
    try { url = new URL(href, window.location.href); }
    catch (err) { return; }
    if (url.origin !== window.location.origin) return;

    if (/\/login\.html$/.test(url.pathname)) {
      e.preventDefault();
      openLogin();
    } else if (/\/settings\.html$/.test(url.pathname)) {
      e.preventDefault();
      openSettings();
    }
  });

  /* ============ 5. login modal logic ============ */

  function msg(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'zeus-login-message' + (type ? ' zeus-login-message--' + type : '');
  }

  function renderLoginState() {
    if (!loginCard) return;
    var user = (typeof authGetCurrentUser === 'function') ? authGetCurrentUser() : null;
    var signed = loginCard.querySelector('.zeus-login-signedin');
    var signin = loginCard.querySelector('#zeus-login-signin');
    var signup = loginCard.querySelector('#zeus-login-signup');
    var alt = loginCard.querySelector('.zeus-login-alt');

    if (user && user.email) {
      signed.hidden = false;
      signin.hidden = true;
      signup.hidden = true;
      alt.hidden = true;
      loginCard.querySelector('.zeus-login-signedin-email').textContent = user.email;
      var avatar = loginCard.querySelector('.zeus-login-avatar');
      avatar.textContent = (typeof authInitialFor === 'function')
        ? authInitialFor(user.email)
        : (user.email.charAt(0) || 'Z').toUpperCase();
    } else {
      signed.hidden = true;
      signin.hidden = false;
      signup.hidden = true;
      alt.hidden = false;
      signin.querySelector('input[type="password"]').value = '';
      msg(signin.querySelector('.zeus-login-message'));
      msg(signup.querySelector('.zeus-login-message'));
    }
  }

  function afterAuth(user, remember) {
    if (!remember) {
      try { localStorage.setItem('zeus_signout_on_exit', '1'); } catch (e) { /* blocked */ }
    }
    renderLoginState();
    var signin = loginCard.querySelector('#zeus-login-signin');
    var signup = loginCard.querySelector('#zeus-login-signup');
    msg(signin.querySelector('.zeus-login-message'), 'Signed in as ' + user.email + '.', 'success');
    msg(signup.querySelector('.zeus-login-message'));
    if (typeof showToast === 'function') showToast('Signed in as ' + user.email + '.', 'success');
    setTimeout(function () {
      if (!loginBackdrop.classList.contains('zeus-modal-closing')) hideModal(loginBackdrop);
    }, 900);
  }

  function bindLogin() {
    var signin = loginCard.querySelector('#zeus-login-signin');
    var signup = loginCard.querySelector('#zeus-login-signup');

    /* mode swap links */
    loginCard.querySelector('.zeus-signup-link').addEventListener('click', function (e) {
      e.preventDefault();
      signin.hidden = true;
      signup.hidden = false;
      msg(signup.querySelector('.zeus-login-message'));
      var em = signup.querySelector('input[type="email"]');
      if (em) em.focus();
    });
    loginCard.querySelector('.zeus-back-link').addEventListener('click', function (e) {
      e.preventDefault();
      signup.hidden = true;
      signin.hidden = false;
      msg(signin.querySelector('.zeus-login-message'));
      var em = signin.querySelector('input[type="email"]');
      if (em) em.focus();
    });

    /* forgot password — local accounts have no email reset */
    loginCard.querySelector('.zeus-forgot-link').addEventListener('click', function (e) {
      e.preventDefault();
      msg(signin.querySelector('.zeus-login-message'),
        'Local accounts can\u2019t be reset by email. Create a new account, or generate one instantly from the Login page.');
    });

    /* sign in */
    signin.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (signin.querySelector('input[type="email"]').value || '').trim();
      var password = signin.querySelector('input[type="password"]').value || '';
      var remember = !!signin.querySelector('.zeus-remember input').checked;
      var mEl = signin.querySelector('.zeus-login-message');
      if (typeof authSignIn !== 'function') {
        msg(mEl, 'Sign-in is unavailable on this page.', 'error');
        return;
      }
      authSignIn(email, password)
        .then(function (user) { afterAuth(user, remember); })
        .catch(function (err) { msg(mEl, (err && err.message) || 'Could not sign in.', 'error'); });
    });

    /* create account */
    signup.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (signup.querySelector('input[type="email"]').value || '').trim();
      var password = signup.querySelector('input[type="password"]').value || '';
      var mEl = signup.querySelector('.zeus-login-message');
      if (typeof authSignUp !== 'function') {
        msg(mEl, 'Account creation is unavailable on this page.', 'error');
        return;
      }
      authSignUp(email, password)
        .then(function (user) {
          msg(mEl);
          afterAuth(user, true);
        })
        .catch(function (err) { msg(mEl, (err && err.message) || 'Could not create the account.', 'error'); });
    });

    /* sign out (signed-in state) */
    loginCard.querySelector('.zeus-login-signout').addEventListener('click', function () {
      if (typeof authSignOut === 'function') authSignOut();
      renderLoginState();
      if (typeof showToast === 'function') showToast('Signed out.', 'success');
    });
  }

  /* ============ 6. settings modal logic ============ */

  var SETTINGS_KEY = 'zeus_settings';
  var AUTO_NEXT_PLAYER_KEY = 'zeus_autonext_v1';
  var LIBRARY_KEY_PREFIX = 'zeus_user_library_';

  var DEFAULTS = {
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

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      var merged = {};
      Object.keys(DEFAULTS).forEach(function (key) {
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
      if (typeof showToast === 'function') showToast('Could not save — storage is full or blocked.', 'error');
      return false;
    }
  }

  /* same live application as settings.js (theme/accent/motion/
     subtitle size + the AutoNext mirror the player reads) */
  function applySettings(settings) {
    var root = document.documentElement;

    if (settings.theme && settings.theme !== 'dark') root.setAttribute('data-theme', settings.theme);
    else root.removeAttribute('data-theme');

    if (settings.accent && settings.accent !== 'gold') root.setAttribute('data-accent', settings.accent);
    else root.removeAttribute('data-accent');

    if (settings.reduceMotion) root.setAttribute('data-reduce-motion', '1');
    else root.removeAttribute('data-reduce-motion');

    root.style.setProperty('--zeus-sub-size', String(settings.subtitleSize / 100));

    var label = settingsCard.querySelector('#zm-sub-size-label');
    if (label) label.textContent = settings.subtitleSize + '%';

    try {
      localStorage.setItem(AUTO_NEXT_PLAYER_KEY, settings.autoplayNext ? '1' : '0');
    } catch (err) { /* blocked — the UI toggle still persists */ }
  }

  function esc(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function formatOffset(ms) {
    if (!ms) return '0s';
    var seconds = ms / 1000;
    return (seconds > 0 ? '+' : '') + seconds.toFixed(1) + 's';
  }

  /* repaint every control from storage — run on each open so
     external changes (another tab / the settings page) show up */
  function syncSettingsControls() {
    var st = loadSettings();
    var S = settingsCard;

    S.querySelectorAll('[data-setting]').forEach(function (input) {
      if (input.type === 'checkbox') input.checked = !!st[input.dataset.setting];
    });
    S.querySelectorAll('.zeus-segment[data-setting], .zeus-swatches[data-setting]').forEach(function (group) {
      var k = group.dataset.setting;
      group.querySelectorAll('input[type="radio"]').forEach(function (r) {
        r.checked = r.value === String(st[k]);
      });
    });
    S.querySelectorAll('select[data-setting]').forEach(function (sel) {
      sel.value = st[sel.dataset.setting];
    });
    var range = S.querySelector('.zeus-range[data-setting]');
    if (range) range.value = st[range.dataset.setting];
    var label = S.querySelector('#zm-sub-size-label');
    if (label) label.textContent = st.subtitleSize + '%';

    /* subtitle colour / timing / preferred language (own keys) */
    var subs = window.ZEUS && window.ZEUS.subtitles;
    if (subs) {
      var currentColor = (subs.getColor() || '#ffffff').toLowerCase();
      S.querySelectorAll('input[name="zm-sub-color"]').forEach(function (r) {
        r.checked = r.value.toLowerCase() === currentColor;
      });
      var custom = S.querySelector('#zm-sub-color-custom');
      if (custom) custom.value = subs.getColor() || '#ffffff';

      var offsetRange = S.querySelector('#zm-sub-offset-range');
      if (offsetRange) {
        offsetRange.value = String(subs.getOffset());
        var offsetLabel = S.querySelector('#zm-sub-offset-label');
        if (offsetLabel) offsetLabel.textContent = formatOffset(subs.getOffset());
      }
      var pref = S.querySelector('#zm-sub-pref-select');
      if (pref && typeof subs.getPref === 'function') pref.value = subs.getPref() || '';
    }

    renderDeviceList();
    applySettings(st);   /* live-apply what was loaded (e.g. first visit) */
  }

  /* mirror modal changes onto the real settings page behind it */
  function syncPageControls() {
    var page = document.querySelector('main.settings-page');
    if (!page) return;
    var st = loadSettings();
    page.querySelectorAll('[data-setting]').forEach(function (input) {
      if (input.type === 'checkbox') input.checked = !!st[input.dataset.setting];
    });
    page.querySelectorAll('.zeus-segment[data-setting], .zeus-swatches[data-setting]').forEach(function (group) {
      var k = group.dataset.setting;
      group.querySelectorAll('input[type="radio"]').forEach(function (r) {
        r.checked = r.value === String(st[k]);
      });
    });
    page.querySelectorAll('select[data-setting]').forEach(function (sel) {
      sel.value = st[sel.dataset.setting];
    });
    var sizeLabel = page.querySelector('#sub-size-label');
    if (sizeLabel) sizeLabel.textContent = st.subtitleSize + '%';
  }

  function renderDeviceList() {
    var list = settingsCard.querySelector('#zm-device-list');
    if (!list) return;
    var user = (typeof authGetCurrentUser === 'function') ? authGetCurrentUser() : null;

    var items = [
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
      return '<li class="device-item">' + item.icon +
        '<div class="device-item-meta"><p class="device-item-name">' + item.name +
        '</p><p class="device-item-sub">' + item.sub + '</p></div>' +
        '<span class="device-item-badge">' + item.badge + '</span></li>';
    }).join('') +
    '<li class="device-item"><div class="device-item-meta"><p class="device-item-sub">' +
      'ZEUS local accounts live only in this browser — there are no remote sessions to review or revoke.' +
    '</p></div></li>';
  }

  function clearWatchHistory() {
    var cleared = 0;
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(LIBRARY_KEY_PREFIX) === 0) keys.push(key);
      }
      keys.forEach(function (key) {
        try {
          var raw = localStorage.getItem(key);
          var lib = raw ? JSON.parse(raw) : null;
          if (lib && typeof lib === 'object') {
            lib.watchedMovies = [];
            localStorage.setItem(key, JSON.stringify(lib));
            cleared++;
          }
        } catch (err) { /* skip corrupted entry */ }
      });
      if (typeof showToast === 'function') {
        showToast('Watch history cleared' + (cleared ? ' (' + cleared + ' profile' + (cleared === 1 ? '' : 's') + ')' : '') + '.', 'success');
      }
    } catch (err) {
      if (typeof showToast === 'function') showToast('Could not clear history — storage is blocked.', 'error');
    }
  }

  function bindSettings() {
    var S = settingsCard;

    /* checkboxes */
    S.querySelectorAll('[data-setting]').forEach(function (input) {
      if (input.type !== 'checkbox') return;
      input.addEventListener('change', function () {
        var st = loadSettings();
        st[input.dataset.setting] = input.checked;
        saveSettings(st);
        applySettings(st);
        syncPageControls();
      });
    });

    /* segmented radio groups + accent swatches */
    S.querySelectorAll('.zeus-segment[data-setting], .zeus-swatches[data-setting]').forEach(function (group) {
      var key = group.dataset.setting;
      group.querySelectorAll('input[type="radio"]').forEach(function (radio) {
        radio.addEventListener('change', function () {
          if (!radio.checked) return;
          var st = loadSettings();
          st[key] = radio.value;
          saveSettings(st);
          applySettings(st);
          syncPageControls();
        });
      });
    });

    /* selects */
    S.querySelectorAll('select[data-setting]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var st = loadSettings();
        st[sel.dataset.setting] = sel.value;
        saveSettings(st);
        applySettings(st);
        syncPageControls();
      });
    });

    /* subtitle size range — live preview while dragging, save on release */
    var range = S.querySelector('.zeus-range[data-setting]');
    if (range) {
      range.addEventListener('input', function () {
        var st = loadSettings();
        st.subtitleSize = Number(range.value);
        applySettings(st);            /* instant preview, not saved yet */
      });
      range.addEventListener('change', function () {
        var st = loadSettings();
        st.subtitleSize = Number(range.value);
        saveSettings(st);
        syncPageControls();
      });
    }

    /* subtitle colour + timing + preferred language (window.ZEUS.subtitles) */
    var subs = window.ZEUS && window.ZEUS.subtitles;

    S.querySelectorAll('input[name="zm-sub-color"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked || !subs) return;
        subs.saveColor(radio.value);
        var custom = S.querySelector('#zm-sub-color-custom');
        if (custom) custom.value = radio.value;
      });
    });

    var custom = S.querySelector('#zm-sub-color-custom');
    if (custom) {
      custom.addEventListener('input', function () {
        if (!subs) return;
        subs.saveColor(custom.value);
        S.querySelectorAll('input[name="zm-sub-color"]').forEach(function (radio) {
          radio.checked = radio.value.toLowerCase() === custom.value.toLowerCase();
        });
      });
    }

    var offsetRange = S.querySelector('#zm-sub-offset-range');
    if (offsetRange) {
      offsetRange.addEventListener('input', function () {
        if (!subs) return;
        var ms = Number(offsetRange.value) || 0;
        var offsetLabel = S.querySelector('#zm-sub-offset-label');
        if (offsetLabel) offsetLabel.textContent = formatOffset(ms);
        subs.saveOffset(ms);
      });
    }

    var offsetReset = S.querySelector('#zm-sub-offset-reset');
    if (offsetReset) {
      offsetReset.addEventListener('click', function () {
        if (offsetRange) offsetRange.value = '0';
        var offsetLabel = S.querySelector('#zm-sub-offset-label');
        if (offsetLabel) offsetLabel.textContent = '0s';
        if (subs) subs.saveOffset(0);
        if (typeof showToast === 'function') showToast('Subtitle timing reset.', 'success');
      });
    }

    var pref = S.querySelector('#zm-sub-pref-select');
    if (pref) {
      pref.addEventListener('change', function () {
        if (!subs || typeof subs.savePref !== 'function') return;
        subs.savePref(pref.value);
        var label = pref.options[pref.selectedIndex].text;
        if (typeof showToast === 'function') {
          showToast(pref.value ? 'Preferred subtitles: ' + label + '.' : 'Preferred subtitles cleared.', 'success');
        }
      });
    }

    /* privacy + devices actions */
    var clearBtn = S.querySelector('#zm-clear-history');
    if (clearBtn) clearBtn.addEventListener('click', clearWatchHistory);

    var signOutAll = S.querySelector('#zm-sign-out-all');
    if (signOutAll) {
      signOutAll.addEventListener('click', function () {
        try {
          if (typeof authSignOut === 'function') authSignOut();
          renderDeviceList();
          if (typeof showToast === 'function') showToast('Signed out of all devices.', 'success');
        } catch (err) {
          if (typeof showToast === 'function') showToast('Could not sign out — storage is blocked.', 'error');
        }
      });
    }
  }

  /* ============ 7. cross-tab / cross-page auth sync ============ */

  window.addEventListener('zeus-auth-change', function () {
    if (loginCard) renderLoginState();
    if (settingsCard) renderDeviceList();
  });

  /* ============ 8. boot ============ */

  function boot() {
    build();
    renderLoginState();   /* cheap; keeps avatar state warm */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
