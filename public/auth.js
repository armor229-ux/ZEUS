/* ============================================================
   ZEUS - auth.js
   Local accounts: creation, sign in / sign out and the
   top-right header "Login / Account" entry (sits directly next
   to the search icon in .nav-actions). 100% browser-local
   (localStorage), no server, no external auth. Passwords are
   never stored in plaintext — SHA-256(email + ":" + password)
   via Web Crypto.

   Storage contract:
     zeus_users         => JSON array of { id, email, passwordHash, createdAt }
     zeus_current_user  => { id, email, loginAt }

   Signed out -> "Login" pill linking to login.html.
   Signed in  -> avatar circle with the user's initial + dropdown
                 (Account -> account.html, Log out).
   ============================================================ */

'use strict';

/* ---------------- Storage keys ---------------- */
const ZEUS_AUTH_USERS_KEY = 'zeus_users';
const ZEUS_AUTH_CURRENT_KEY = 'zeus_current_user';

/* ---------------- Validation ---------------- */
const ZEUS_AUTH_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authNormalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/* ---------------- Web Crypto helpers ---------------- */

/** SHA-256 hex digest of a string (browser Web Crypto). */
async function authSha256Hex(text) {
  if (!window.crypto || !crypto.subtle || !crypto.subtle.digest) {
    throw new Error('Web Crypto is not available in this context (an HTTPS connection is required).');
  }
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Deterministic local password hash: SHA256(email + ":" + password). */
function authHashPassword(email, password) {
  return authSha256Hex(authNormalizeEmail(email) + ':' + String(password || ''));
}

/** Random id (crypto.randomUUID with a safe fallback). */
function authMakeId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random alphanumeric string (for generated accounts). */
function authRandomAlphanum(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[values[i] % chars.length];
  return out;
}

/* ---------------- localStorage access ---------------- */

function authGetUsers() {
  try {
    const raw = localStorage.getItem(ZEUS_AUTH_USERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function authSaveUsers(users) {
  localStorage.setItem(ZEUS_AUTH_USERS_KEY, JSON.stringify(users));
}

/** Currently signed-in user: { id, email, loginAt } or null. */
function authGetCurrentUser() {
  try {
    const raw = localStorage.getItem(ZEUS_AUTH_CURRENT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === 'object' && parsed.email) ? parsed : null;
  } catch (err) {
    return null;
  }
}

function authSetCurrentUser(user) {
  localStorage.setItem(ZEUS_AUTH_CURRENT_KEY, JSON.stringify({
    id: user.id,
    email: user.email,
    loginAt: new Date().toISOString()
  }));
}

function authClearCurrentUser() {
  localStorage.removeItem(ZEUS_AUTH_CURRENT_KEY);
}

/* ---------------- Auth state change events ---------------- */

/** Notify the page (nav entry, account page) that auth state changed. */
function authBroadcast() {
  window.dispatchEvent(new CustomEvent('zeus-auth-change', {
    detail: { user: authGetCurrentUser() }
  }));
}

/* ---------------- Auth flows ---------------- */

/** Create the user record and auto-login (shared by signUp and generate). */
async function authCreateAccount(email, password) {
  const users = authGetUsers();
  const user = {
    id: authMakeId(),
    email: email,
    passwordHash: await authHashPassword(email, password),
    createdAt: new Date().toISOString()
  };
  users.push(user);
  authSaveUsers(users);
  authSetCurrentUser(user);
  return user;
}

/**
 * Sign Up — validates, creates the account and logs the user in.
 * @throws Error with a user-facing message on invalid input.
 */
async function authSignUp(email, password) {
  email = authNormalizeEmail(email);
  password = String(password || '');
  if (!email) throw new Error('Please enter your email address.');
  if (!ZEUS_AUTH_EMAIL_RE.test(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (authGetUsers().some((u) => u.email === email)) {
    throw new Error('An account with this email already exists. Try signing in instead.');
  }
  const user = await authCreateAccount(email, password);
  authBroadcast();
  return user;
}

/**
 * Sign In — verifies credentials and sets the current user.
 * @throws Error with a user-facing message on invalid input.
 */
async function authSignIn(email, password) {
  email = authNormalizeEmail(email);
  password = String(password || '');
  if (!email) throw new Error('Please enter your email address.');
  if (!ZEUS_AUTH_EMAIL_RE.test(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const user = authGetUsers().find((u) => u.email === email);
  const hash = await authHashPassword(email, password);
  if (!user || user.passwordHash !== hash) throw new Error('Invalid email or password.');
  authSetCurrentUser(user);
  authBroadcast();
  return user;
}

/** Log out — clears the current user only (saved accounts stay). */
function authSignOut() {
  authClearCurrentUser();
  authBroadcast();
}

/**
 * Generate a local account (user-XXXXXXXX@local.zeus + a strong
 * random password of 12–16 alphanumeric chars), create it and
 * log in automatically — same flow as Sign Up.
 * @returns {Promise<{email: string, password: string, user: object}>}
 */
async function authGenerateLocalAccount() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const email = 'user-' + authRandomAlphanum(8) + '@local.zeus';
    if (authGetUsers().some((u) => u.email === email)) continue; /* collision — retry */
    const password = authRandomAlphanum(12 + Math.floor(Math.random() * 5)); /* 12–16 chars */
    const user = await authCreateAccount(email, password);
    authBroadcast();
    return { email: email, password: password, user: user };
  }
  throw new Error('Could not generate a unique account. Please try again.');
}

/* ============================================================
   TOP-RIGHT HEADER ENTRY ("Login / Account")
   Injected into .nav-actions — the same row as the search icon,
   placed directly next to it (before the mobile hamburger).
   The small stylesheet is injected once so NO existing HTML
   file needs a new <link> line.
   ============================================================ */

/** Tiny local escaper (auth.js must not depend on api.js). */
function authEsc(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Uppercase first letter of the email for the avatar circle. */
function authInitialFor(email) {
  const first = String(email || '').trim().charAt(0);
  return first ? first.toUpperCase() : 'Z';
}

/** Inject the entry's stylesheet once (design tokens from :root). */
function authInjectNavStyles() {
  if (document.getElementById('zeus-auth-nav-styles')) return;
  const style = document.createElement('style');
  style.id = 'zeus-auth-nav-styles';
  style.textContent = `
.nav-account{position:relative;display:flex;align-items:center;flex-shrink:0;}
/* ---- Signed out: "Login" pill ---- */
.nav-account-login{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 15px 0 12px;border-radius:var(--radius-pill,999px);border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.08);color:#fff;font-family:inherit;font-size:13.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;text-decoration:none;transition:background 0.3s ease,border-color 0.3s ease,color 0.3s ease;}
.nav-account-login svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;}
.nav-account-login:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.4);color:#fff;}
/* ---- Signed in: avatar button + dropdown ---- */
.nav-account-btn{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 9px 0 5px;border-radius:var(--radius-pill,999px);border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.08);cursor:pointer;font-family:inherit;transition:background 0.3s ease,border-color 0.3s ease;}
.nav-account-btn:hover{background:rgba(255,255,255,0.15);border-color:rgba(255,215,0,0.5);}
.nav-account-avatar{width:27px;height:27px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(255,215,0,0.28),rgba(255,215,0,0.08));border:1px solid rgba(255,215,0,0.45);color:var(--accent-primary,#FFD700);font-size:12.5px;font-weight:800;line-height:1;}
.nav-account-caret{width:13px;height:13px;fill:none;stroke:rgba(255,255,255,0.72);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;transition:transform 0.25s ease;}
.nav-account.open .nav-account-caret{transform:rotate(180deg);}
.nav-account-menu{position:absolute;top:calc(100% + 10px);right:0;min-width:216px;padding:6px;background:rgba(24,24,26,0.97);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,0.12);border-radius:var(--radius-md,12px);box-shadow:0 24px 60px rgba(0,0,0,0.6);opacity:0;visibility:hidden;transform:translateY(-6px) scale(0.98);transform-origin:top right;transition:opacity 0.22s ease,transform 0.22s ease,visibility 0.22s;z-index:1200;}
.nav-account.open .nav-account-menu{opacity:1;visibility:visible;transform:translateY(0) scale(1);}
.nav-account-email{padding:10px 12px 9px;margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.2px;color:var(--text-secondary,#86868B);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;border-bottom:1px solid rgba(255,255,255,0.08);}
.nav-account-item{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:none;border-radius:var(--radius-sm,8px);background:transparent;color:var(--text-primary,#F5F5F7);font-family:inherit;font-size:13.5px;font-weight:600;line-height:1;cursor:pointer;text-decoration:none;box-sizing:border-box;transition:background 0.2s ease,color 0.2s ease;}
.nav-account-item svg{width:16px;height:16px;fill:currentColor;flex-shrink:0;}
a.nav-account-item:hover,button.nav-account-item:hover{background:rgba(255,255,255,0.09);color:#fff;}
.nav-account-item--logout{color:#FF6961;}
.nav-account-item--logout:hover{background:rgba(255,69,58,0.12);color:#FF6961;}
@media (max-width:480px){
  .nav-account-login span{display:none;}
  .nav-account-login{width:40px;height:40px;padding:0;justify-content:center;border-radius:50%;}
  .nav-account-btn{height:40px;}
  .nav-account-menu{right:-6px;}
}
`;
  document.head.appendChild(style);
}

/** Close the dropdown (when open). */
function authCloseNavMenu() {
  const root = document.getElementById('zeus-nav-account');
  if (!root) return;
  root.classList.remove('open');
  const btn = root.querySelector('.nav-account-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/** Render the header entry for the current auth state (idempotent). */
function authRenderNavAccount() {
  const wrap = document.querySelector('.nav-actions');
  if (!wrap) return;
  authInjectNavStyles();

  let root = document.getElementById('zeus-nav-account');
  if (!root) {
    root = document.createElement('div');
    root.id = 'zeus-nav-account';
    root.className = 'nav-account';
    /* Directly next to the search icon — before the mobile hamburger. */
    const hamburger = wrap.querySelector('#hamburger');
    wrap.insertBefore(root, hamburger || null);
  }

  const current = authGetCurrentUser();

  if (!current) {
    /* ---- Signed out: Login pill ---- */
    root.classList.remove('open');
    root.innerHTML = '';
    const link = document.createElement('a');
    link.href = 'login.html';
    link.className = 'nav-account-login';
    link.title = 'Sign in or create a local account';
    link.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>' +
      '<span>Login</span>';
    root.appendChild(link);
    return;
  }

  /* ---- Signed in: avatar + dropdown ---- */
  const emailText = authEsc(current.email);
  const initial = authEsc(authInitialFor(current.email));
  root.innerHTML =
    '<button class="nav-account-btn" type="button" aria-haspopup="true" aria-expanded="false"' +
    ' aria-label="Account menu — signed in as ' + emailText + '" title="Signed in as ' + emailText + '">' +
      '<span class="nav-account-avatar" aria-hidden="true">' + initial + '</span>' +
      '<svg class="nav-account-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>' +
    '</button>' +
    '<div class="nav-account-menu" role="menu" aria-label="Account menu">' +
      '<p class="nav-account-email">' + emailText + '</p>' +
      '<a class="nav-account-item" role="menuitem" href="account.html">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm0 15.5a8.03 8.03 0 0 1-5.66-2.33c.9-1.62 2.62-2.67 4.56-2.67h2.2c1.94 0 3.66 1.05 4.56 2.67A8.03 8.03 0 0 1 12 20.5z"/></svg>' +
        'Account' +
      '</a>' +
      '<button class="nav-account-item nav-account-item--logout" type="button" role="menuitem">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.59L17 17l5-5-5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z"/></svg>' +
        'Log out' +
      '</button>' +
    '</div>';

  const btn = root.querySelector('.nav-account-btn');
  if (btn) {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = root.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
  }
  root.querySelectorAll('.nav-account-item').forEach((item) => {
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      authCloseNavMenu();
    });
  });
  const logout = root.querySelector('.nav-account-item--logout');
  if (logout) {
    logout.addEventListener('click', () => {
      authSignOut();
      if (typeof showToast === 'function') showToast('You have been signed out', 'info');
      authRenderNavAccount();
    });
  }
}

/** One-time global listeners: close the dropdown on outside click / Escape. */
let authNavListenersBound = false;
function authBindNavListeners() {
  if (authNavListenersBound) return;
  authNavListenersBound = true;
  document.addEventListener('click', (event) => {
    const root = document.getElementById('zeus-nav-account');
    if (root && root.classList.contains('open') && !root.contains(event.target)) {
      authCloseNavMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') authCloseNavMenu();
  });
}

/* ---------------- Global wiring (every page) ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  authBindNavListeners();
  authRenderNavAccount();
});

/* Cross-tab sync: another tab signed in / out */
window.addEventListener('storage', (event) => {
  if (event.key === ZEUS_AUTH_CURRENT_KEY) authRenderNavAccount();
});

/* In-page auth state changes (Login page / dropdown actions) */
window.addEventListener('zeus-auth-change', authRenderNavAccount);
