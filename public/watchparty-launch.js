/* Open the separate CineSrc party in the same tab. Normal playback and its
   server list are otherwise untouched; navigating away stops its iframe. */
(function () {
  'use strict';

  function destination(invite) {
    const url = new URL('party.html', location.href);
    const bridge = window.ZeusWatchPartyBridge;
    const media = bridge && typeof bridge.getMedia === 'function' ? bridge.getMedia() : null;
    if (media && /^[0-9]{1,12}$/.test(String(media.id)) && ['movie', 'tv'].includes(media.type)) {
      url.searchParams.set('id', String(media.id));
      url.searchParams.set('type', media.type);
      if (media.title) url.searchParams.set('title', String(media.title).slice(0, 200));
      if (media.type === 'tv') {
        url.searchParams.set('season', String(media.season));
        url.searchParams.set('episode', String(media.episode));
      }
    }
    if (invite) url.hash = 'party=' + invite;
    return url.href;
  }

  function openParty(invite) {
    const next = destination(invite);
    const bridge = window.ZeusWatchPartyBridge;
    if (bridge && typeof bridge.enter === 'function') bridge.enter('cinesrc');
    // A normal-viewing server check can have a separate hidden probe in
    // flight. Tear it down on entering party mode so it cannot keep playing.
    document.querySelectorAll('iframe[title="server test"]').forEach(frame => {
      frame.src = 'about:blank';
      frame.remove();
    });
    location.assign(next);
  }

  function mount() {
    const shell = document.getElementById('player-shell');
    const mountPoint = shell && shell.querySelector('.chrome-right');
    const player = document.getElementById('player-wrapper');
    if (!mountPoint || !player || document.getElementById('watch-party-btn')) return;

    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13Zm8 0c-.4 0-.7 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5Z"/></svg>';
    const button = document.createElement('button');
    button.id = 'watch-party-btn';
    button.type = 'button';
    button.className = 'chrome-btn chrome-btn--watchparty';
    button.innerHTML = icon + '<span>Watch Party</span>';
    button.addEventListener('click', () => openParty(''));
    mountPoint.appendChild(button);

    const tools = document.createElement('div');
    tools.className = 'wp-stage-tools';
    const stageButton = document.createElement('button');
    stageButton.type = 'button';
    stageButton.className = 'wp-stage-button';
    stageButton.innerHTML = icon + '<span>Party</span>';
    stageButton.addEventListener('click', () => openParty(''));
    tools.appendChild(stageButton);
    player.appendChild(tools);

    // Earlier ZEUS invites used watch.html#party=<code>. Preserve those links
    // by opening the dedicated page in the same tab, without sharing a token.
    const code = (new URLSearchParams(location.hash.slice(1)).get('party') || '').toUpperCase();
    if (/^[0-9A-F]{20}$/.test(code)) openParty(code);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
