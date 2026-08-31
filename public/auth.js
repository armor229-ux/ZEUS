/* ============================================================
   ZEUS - auth.js
   Local accounts: creation, sign in / sign out and a navbar
   "Login / Account" link. 100% browser-local (localStorage),
   no server, no external auth. Passwords are never stored in
   plaintext — SHA-256(email + ":" + password) via Web Crypto.

   Storage contract:
     zeus_users         => JSON array of { id, email, passwordHash, createdAt }
     zeus_current_user  => { id, email, loginAt }
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

/** Notify the page (nav label, login view) that auth state changed. */
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

/* ---------------- Navbar "Login / Account" link ----------------
   The .nav-links list powers both the desktop bar and the
   mobile slide-in drawer, so one injected <li> covers both. */

function authUpdateNavLink() {
  const link = document.querySelector('#nav-menu .nav-links a[href="login.html"]');
  if (!link) return;
  const current = authGetCurrentUser();
  link.textContent = current ? 'Account' : 'Login';
  link.title = current
    ? 'Signed in as ' + current.email
    : 'Sign in or create a local account';
}

/** Inject the Login link into the navbar (idempotent). */
function authInjectNavLink() {
  const ul = document.querySelector('#nav-menu .nav-links');
  if (!ul) return;
  if (!document.querySelector('#nav-menu .nav-links a[href="login.html"]')) {
    const li = document.createElement('li');
    li.className = 'nav-auth-item';
    const link = document.createElement('a');
    link.href = 'login.html';
    link.className = 'nav-link';
    link.setAttribute('data-nav', 'login');
    li.appendChild(link);
    ul.appendChild(li);
  }
  authUpdateNavLink();
}

/* ---------------- Global wiring (every page) ---------------- */

document.addEventListener('DOMContentLoaded', authInjectNavLink);

/* Cross-tab sync: another tab signed in / out */
window.addEventListener('storage', (event) => {
  if (event.key === ZEUS_AUTH_CURRENT_KEY) authUpdateNavLink();
});

/* In-page auth state changes (Login page actions) */
window.addEventListener('zeus-auth-change', authUpdateNavLink);
