/* ============================================================
   ZEUS - login.js
   Login / Account page behaviour: Sign In, Sign Up, Log Out,
   and the "Generate Local Account" flow with Copy button.
   Depends on auth.js (authSignUp / authSignIn / authSignOut /
   authGenerateLocalAccount / authGetCurrentUser / authGetUsers).
   ============================================================ */

'use strict';

(function () {

  /* ---------------- Elements ---------------- */
  const authCard = document.getElementById('auth-card');
  const accountCard = document.getElementById('account-card');
  const tabSignIn = document.getElementById('tab-signin');
  const tabSignUp = document.getElementById('tab-signup');
  const signInForm = document.getElementById('signin-form');
  const signUpForm = document.getElementById('signup-form');
  const messageEl = document.getElementById('auth-message');

  const generateBtn = document.getElementById('generate-btn');
  const generatedBox = document.getElementById('auth-generated');
  const generatedEmail = document.getElementById('generated-email');
  const generatedPassword = document.getElementById('generated-password');
  const copyBtn = document.getElementById('generated-copy-btn');

  const accountEmail = document.getElementById('account-email');
  const accountMeta = document.getElementById('account-meta');
  const logoutBtn = document.getElementById('logout-btn');

  let generatedCredentials = null;

  /* ---------------- Inline messages ---------------- */
  function setMessage(text, type) {
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.className = 'auth-message visible auth-message--' + (type || 'error');
  }

  function clearMessage() {
    if (!messageEl) return;
    messageEl.textContent = '';
    messageEl.className = 'auth-message';
  }

  /* ---------------- Clipboard ---------------- */
  async function copyText(text) {
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

  /* ---------------- View rendering ---------------- */
  function render() {
    const current = authGetCurrentUser();
    if (current) {
      authCard.hidden = true;
      accountCard.hidden = false;
      accountEmail.textContent = current.email;
      const record = authGetUsers().find((u) => u.id === current.id);
      if (record && record.createdAt) {
        const created = new Date(record.createdAt);
        accountMeta.textContent = 'Member since ' + created.toLocaleDateString(
          undefined, { year: 'numeric', month: 'long', day: 'numeric' }
        ) + ' — local account, stored in this browser only';
      } else {
        accountMeta.textContent = 'Local account — stored in this browser only';
      }
    } else {
      authCard.hidden = false;
      accountCard.hidden = true;
    }
  }

  /* ---------------- Tabs ---------------- */
  function selectTab(which) {
    const isSignIn = which === 'signin';
    tabSignIn.classList.toggle('active', isSignIn);
    tabSignUp.classList.toggle('active', !isSignIn);
    tabSignIn.setAttribute('aria-selected', String(isSignIn));
    tabSignUp.setAttribute('aria-selected', String(!isSignIn));
    signInForm.hidden = !isSignIn;
    signUpForm.hidden = isSignIn;
    clearMessage();
  }

  /* ---------------- Sign In ---------------- */
  async function handleSignIn(event) {
    event.preventDefault();
    clearMessage();
    const email = document.getElementById('signin-email').value;
    const password = document.getElementById('signin-password').value;
    const submit = document.getElementById('signin-submit');
    submit.disabled = true;
    try {
      const user = await authSignIn(email, password);
      if (typeof showToast === 'function') showToast('Signed in as ' + user.email, 'success');
      render();
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  }

  /* ---------------- Sign Up ---------------- */
  async function handleSignUp(event) {
    event.preventDefault();
    clearMessage();
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const submit = document.getElementById('signup-submit');
    submit.disabled = true;
    try {
      const user = await authSignUp(email, password);
      if (typeof showToast === 'function') showToast('Account created — welcome, ' + user.email, 'success');
      render();
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  }

  /* ---------------- Generate Local Account ---------------- */
  async function handleGenerate() {
    clearMessage();
    const label = generateBtn.innerHTML;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    try {
      const result = await authGenerateLocalAccount();
      generatedCredentials = result;
      generatedEmail.textContent = result.email;
      generatedPassword.textContent = result.password;
      generatedBox.hidden = false;
      if (typeof showToast === 'function') showToast('Local account created and signed in', 'success');
      render();
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      generateBtn.disabled = false;
      generateBtn.innerHTML = label;
    }
  }

  /* ---------------- Copy generated credentials ---------------- */
  async function handleCopy() {
    if (!generatedCredentials) return;
    const line = 'email: ' + generatedCredentials.email + '  password: ' + generatedCredentials.password;
    const ok = await copyText(line);
    if (ok) {
      setMessage('Credentials copied to clipboard.', 'success');
      if (typeof showToast === 'function') showToast('Account copied to clipboard', 'success');
    } else {
      setMessage('Copy failed — please select and copy the credentials manually.', 'error');
    }
  }

  /* ---------------- Log Out ---------------- */
  function handleLogout() {
    authSignOut();
    generatedCredentials = null;
    generatedBox.hidden = true;
    signInForm.reset();
    signUpForm.reset();
    selectTab('signin');
    if (typeof showToast === 'function') showToast('You have been signed out', 'info');
    render();
  }

  /* ---------------- Wiring ---------------- */
  if (tabSignIn) tabSignIn.addEventListener('click', () => selectTab('signin'));
  if (tabSignUp) tabSignUp.addEventListener('click', () => selectTab('signup'));
  if (signInForm) signInForm.addEventListener('submit', handleSignIn);
  if (signUpForm) signUpForm.addEventListener('submit', handleSignUp);
  if (generateBtn) generateBtn.addEventListener('click', handleGenerate);
  if (copyBtn) copyBtn.addEventListener('click', handleCopy);
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  /* Common UI (page loader, navbar, hamburger, disclaimer banner,
     back-to-top, footer year) — every ZEUS page script calls this
     at DOMContentLoaded (same pattern as legal.js). */
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof initCommonUI === 'function') initCommonUI();
  });

  /* ---------------- Init ---------------- */
  render();

})();
