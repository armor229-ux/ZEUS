/* ZEUS in-player Watch Party. Vidora remains the normal-viewing player.
   Room authority is enforced by the Supabase functions, not by this UI.
   The public project key is intentionally publishable, never a service key. */
(function () {
  'use strict';

  const PROJECT_URL = 'https://gqjgmniwvqcpsurzmbet.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_74MGBFkvRcyd_uoJ1DLSnQ_yj4ap7mg';
  const SDK_URL = 'vendor/supabase-2.119.2.js';
  const NAME_KEY = 'zeus_party_display_name_v1';
  const ACTIVE_KEY = 'zeus_party_active_v1';
  const AUTH_KEY = 'zeus_party_auth_v1';
  const POLL_MS = 4000;
  const HEARTBEAT_MS = 18000;
  const STATUS_MS = 2000;
  const DRIFT_SECONDS = 1.6;
  const players = window.ZeusPartyPlayers;
  const bridge = window.ZeusWatchPartyBridge;
  if (!players || !bridge) return;

  const state = {
    client: null, channel: null, code: '', snapshot: null, isHost: false,
    generation: 0, loading: false, refreshing: false, refreshAgain: false,
    refreshTimer: null, pollTimer: null, heartbeatTimer: null, statusTimer: null, displayTimer: null,
    serverOffset: 0, provider: '', player: null, lastMessageKey: null, lastSnapshotAt: 0, connectionKind: '',
    hostQueue: Promise.resolve(), lastHostSync: 0, live: false,
    channelRetry: null, retryDelay: 2000,
    initialApplied: false, lastSeek: 0, lastPlayCommand: 0, playAttempts: 0,
    episodeChanged: false, switchingProvider: false, enforceSwitchPause: false, lastPlayerNotice: '',
    sourcePending: null, sourceSyncChanging: false, normalVidora: null, preservePlayer: false,
    vidoraNeedsRetry: false, vidoraNeedsClear: false, vidoraClearTime: 0, lastVidoraRetry: 0, panelOpener: null,
  };
  let ui;

  function readSession(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (error) { return ''; }
  }
  function writeSession(key, value) {
    try { sessionStorage.setItem(key, value); return true; } catch (error) { return false; }
  }
  function removeSession(key) {
    try { sessionStorage.removeItem(key); } catch (error) { /* no session storage */ }
  }
  function nameValue() {
    return String(ui.name.value || '').trim().slice(0, 32);
  }
  function rememberName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (error) { /* optional */ }
  }
  function savedName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (error) { return ''; }
  }
  function nameOrError() {
    const name = nameValue();
    if (!name) { showError('Enter a display name first.'); ui.name.focus(); return ''; }
    rememberName(name);
    return name;
  }
  function showError(message) {
    ui.error.textContent = String(message || '');
    ui.error.hidden = !message;
    if (message && typeof ui.error.scrollIntoView === 'function') ui.error.scrollIntoView({ block: 'nearest' });
  }
  function friendlyError(error) {
    const message = String(error && error.message || error || '');
    if (/anonymous.*(disabled|not enabled)|signups not allowed/i.test(message)) {
      return 'The party service is not ready for guest sign-in yet.';
    }
    if (/fetch|network|connection|timeout/i.test(message)) return 'Could not reach the party service. Check your connection and try again.';
    if (/party not found|has ended|access denied/i.test(message)) return 'Party not found, has ended, or access was denied.';
    return message ? message.slice(0, 200) : 'Something went wrong. Please try again.';
  }
  function setBusy(busy) {
    state.loading = busy;
    ui.create.disabled = busy;
    ui.join.disabled = busy;
    ui.create.textContent = busy ? 'Connecting…' : 'Start a party';
  }
  function setConnection(label, kind) {
    state.connectionKind = kind || '';
    ui.connection.textContent = label;
    ui.connection.dataset.state = state.connectionKind;
  }
  function playerNotice(text) {
    if (state.lastPlayerNotice === text) return;
    state.lastPlayerNotice = text;
    ui.playerNotice.textContent = text;
  }
  function setPanel(open, opener) {
    if (open) state.panelOpener = opener || ui.button;
    ui.panel.hidden = !open;
    ui.button.setAttribute('aria-expanded', String(open));
    ui.stageButton.setAttribute('aria-expanded', String(open));
    ui.workspace.classList.toggle('wp-open', open);
    if (open) {
      document.documentElement.classList.remove('zeus-scroll-lock');
      if (!state.code) ui.name.focus({ preventScroll: true });
      else ui.partyTab.focus({ preventScroll: true });
    } else if (state.panelOpener) state.panelOpener.focus({ preventScroll: true });
  }
  function tab(name) {
    const chat = name === 'chat';
    ui.partyTab.setAttribute('aria-selected', String(!chat));
    ui.chatTab.setAttribute('aria-selected', String(chat));
    ui.partyView.hidden = chat;
    ui.chatView.hidden = !chat;
    if (chat) ui.chatInput.focus({ preventScroll: true });
  }

  function codeFrom(value) {
    const text = String(value || '').trim();
    const direct = players.normalizeCode(text);
    if (direct) return direct;
    try {
      const url = new URL(text, location.href);
      const hash = new URLSearchParams(url.hash.slice(1));
      return players.normalizeCode(hash.get('party') || url.searchParams.get('party') || '');
    } catch (error) { return ''; }
  }
  function currentInviteCode() {
    const hash = new URLSearchParams(location.hash.slice(1));
    return players.normalizeCode(hash.get('party') || '');
  }
  function makeInvite(room) {
    const url = new URL('watch.html', location.href);
    url.search = '';
    url.searchParams.set('id', String(room.tmdb_id));
    url.searchParams.set('type', room.media_type);
    if (room.media_type === 'tv') {
      url.searchParams.set('season', String(room.season));
      url.searchParams.set('episode', String(room.episode));
    }
    // Fragments are not sent in HTTP requests or Referer headers.
    url.hash = 'party=' + room.code;
    return url.href;
  }
  function setAddressCode(code) {
    try {
      const url = new URL(location.href);
      url.hash = code ? 'party=' + code : '';
      history.replaceState(null, '', url.href);
    } catch (error) { /* the room works without a rewritten address */ }
  }
  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); return true; } catch (error) { /* fallback */ }
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { /* no clipboard */ }
    input.remove();
    return copied;
  }

  let sdkPromise;
  function loadSdk() {
    if (window.supabase && typeof window.supabase.createClient === 'function') return Promise.resolve();
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = SDK_URL;
        script.onload = () => window.supabase && window.supabase.createClient ? resolve() : reject(new Error('Party client unavailable'));
        script.onerror = () => reject(new Error('Could not load the party client'));
        document.head.appendChild(script);
      }).catch((error) => { sdkPromise = null; throw error; });
    }
    return sdkPromise;
  }
  async function getClient() {
    if (state.client) return state.client;
    await loadSdk();
    // Session storage preserves the host across a reload. Browsers can clone
    // it into a duplicated or opener-created tab, so independent viewers
    // should use separate browsers/profiles or fresh tabs without an opener.
    const probe = AUTH_KEY + '_test';
    if (!writeSession(probe, '1')) throw new Error('Enable session storage to use Watch Party.');
    removeSession(probe);
    const client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
      auth: { storage: sessionStorage, storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    let result = await client.auth.getSession();
    if (result.error) throw result.error;
    if (!result.data.session) {
      result = await client.auth.signInAnonymously();
      if (result.error) throw result.error;
    }
    const session = result.data.session;
    if (!session || !session.access_token) throw new Error('Unable to create a guest session.');
    await client.realtime.setAuth(session.access_token);
    state.client = client;
    return client;
  }
  async function rpc(client, name, params) {
    const result = await client.rpc(name, params);
    if (result.error) throw result.error;
    return result.data;
  }

  function sameMedia(room) {
    const local = bridge.getMedia();
    return !!local && String(local.id) === String(room.tmdb_id) && local.type === room.media_type &&
      (room.media_type !== 'tv' || (Number(local.season) === Number(room.season) && Number(local.episode) === Number(room.episode)));
  }
  async function begin(action) {
    if (state.loading || state.code) return;
    const name = nameOrError();
    if (!name) return;
    const code = action === 'join' ? codeFrom(ui.codeInput.value) : '';
    if (action === 'join' && !code) { showError('Enter a valid party code or invitation link.'); ui.codeInput.focus(); return; }
    const media = bridge.getMedia();
    if (action === 'create' && !media) { showError('Open a movie or episode before starting a party.'); return; }
    showError('');
    setBusy(true);
    try {
      const client = await getClient();
      const snapshot = action === 'create'
        ? await rpc(client, 'zeus_party_create', {
          p_name: name, p_provider: ui.createProvider.value, p_media_type: media.type,
          p_tmdb_id: media.id, p_season: media.season, p_episode: media.episode, p_title: media.title
        })
        : await rpc(client, 'zeus_party_join', { p_code: code, p_name: name });
      if (!snapshot || !snapshot.room) throw new Error('Party response was incomplete.');
      writeSession(ACTIVE_KEY, JSON.stringify({ code: snapshot.room.code, name }));
      // A pasted code may belong to a different title. Move to its watch page,
      // then rejoin in the same tab with the same temporary identity.
      if (!sameMedia(snapshot.room)) { location.assign(makeInvite(snapshot.room)); return; }
      enterRoom(snapshot);
    } catch (error) {
      showError(friendlyError(error));
    } finally { setBusy(false); }
  }

  function enterRoom(snapshot) {
    state.generation += 1;
    state.code = snapshot.room.code;
    state.lastMessageKey = null;
    state.live = false;
    state.retryDelay = 2000;
    state.preservePlayer = bridge.enter(snapshot.room.provider);
    state.vidoraNeedsRetry = false;
    state.vidoraNeedsClear = false;
    ui.welcome.hidden = true;
    ui.room.hidden = false;
    ui.button.classList.add('wp-active');
    ui.stageButton.classList.add('wp-active');
    syncFullscreenButton();
    setAddressCode(state.code);
    setConnection('Connecting…', 'connecting');
    applySnapshot(snapshot, Date.now(), Date.now());
    subscribe();
    state.pollTimer = setInterval(() => refresh(), POLL_MS);
    state.heartbeatTimer = setInterval(() => heartbeat(), HEARTBEAT_MS);
    state.statusTimer = setInterval(() => checkPlayer(), STATUS_MS);
    state.displayTimer = setInterval(() => renderVidoraGuide(), 1000);
    tab('party');
  }
  function subscribe() {
    const client = state.client;
    const code = state.code;
    const generation = state.generation;
    const channel = client.channel('zeus-party:' + code, { config: { private: true } });
    state.channel = channel;
    channel.on('broadcast', { event: 'changed' }, () => {
      // Broadcasts contain no commands or private data; only an RPC result
      // can change the room. Ignore payloads, including forged wakeups.
      if (state.code === code && state.generation === generation) scheduleRefresh();
    }).subscribe((status) => {
      if (state.code !== code || state.generation !== generation || state.channel !== channel) return;
      if (status === 'SUBSCRIBED') {
        state.live = true;
        state.retryDelay = 2000;
        clearTimeout(state.channelRetry);
        state.channelRetry = null;
        // Subscription alone does not establish broadcast delivery; polling
        // continues regardless, so do not claim that live events were proven.
        setConnection('Connected · auto-checking', 'online');
        refresh();
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        state.live = false;
        setConnection('Reconnecting · checking periodically', 'connecting');
        refresh();
        if (!state.channelRetry) {
          state.channelRetry = setTimeout(async () => {
            state.channelRetry = null;
            if (state.code !== code || state.generation !== generation) return;
            state.channel = null; // ignore the old channel's CLOSED callback
            await client.removeChannel(channel);
            if (state.code === code && state.generation === generation) subscribe();
          }, state.retryDelay);
          state.retryDelay = Math.min(state.retryDelay * 2, 30000);
        }
      }
    });
  }
  function scheduleRefresh() {
    if (state.refreshTimer || !state.code) return;
    state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refresh(); }, 150);
  }
  async function refresh() {
    if (!state.code || !state.client) return;
    if (state.refreshing) { state.refreshAgain = true; return; }
    const generation = state.generation;
    const code = state.code;
    state.refreshing = true;
    const started = Date.now();
    try {
      const snapshot = await rpc(state.client, 'zeus_party_snapshot', { p_code: code });
      if (generation !== state.generation || code !== state.code) return;
      applySnapshot(snapshot, started, Date.now());
      if (state.code === code) setConnection(state.live ? 'Connected · auto-checking' : 'Checking periodically', state.live ? 'online' : 'connecting');
    } catch (error) {
      if (generation === state.generation && code === state.code && error && error.code === '42501') {
        // A long-offline member may have been pruned. Rejoin with the same
        // authenticated identity; this never grants a guest host authority.
        try {
          const active = JSON.parse(readSession(ACTIVE_KEY) || 'null');
          if (active && active.code === code && active.name) {
            const rejoined = await rpc(state.client, 'zeus_party_join', { p_code: code, p_name: active.name });
            if (generation === state.generation && code === state.code) {
              applySnapshot(rejoined, started, Date.now());
              setConnection(state.live ? 'Connected · auto-checking' : 'Checking periodically', state.live ? 'online' : 'connecting');
              return;
            }
          }
        } catch (rejoinError) {
          if (/party not found or has ended/i.test(String(rejoinError && rejoinError.message))) {
            finishRoom('This party is no longer available.');
            return;
          }
        }
      }
      if (generation === state.generation && code === state.code) {
        setConnection('Connection lost · retrying', 'error');
        playerNotice(state.provider === 'vidora'
          ? 'The room connection was interrupted. Vidora playback remains manual.'
          : 'The room connection was interrupted. Playback will try to catch up when it returns.');
      }
    } finally {
      state.refreshing = false;
      if (state.refreshAgain && state.code) { state.refreshAgain = false; scheduleRefresh(); }
    }
  }
  async function heartbeat() {
    if (!state.code || !state.client) return;
    try { await rpc(state.client, 'zeus_party_heartbeat', { p_code: state.code }); }
    catch (error) { if (state.code) { setConnection('Connection lost · retrying', 'error'); refresh(); } }
  }

  function renderMembers(members) {
    ui.members.textContent = '';
    const list = Array.isArray(members) ? members : [];
    ui.memberCount.textContent = String(list.filter((m) => m.online).length);
    list.forEach((member) => {
      const item = document.createElement('li');
      item.className = 'wp-member';
      const avatar = document.createElement('span');
      avatar.className = 'wp-avatar';
      avatar.textContent = String(member.name || '?').trim().slice(0, 1).toUpperCase() || '?';
      const name = document.createElement('span');
      name.className = 'wp-member-name';
      name.textContent = String(member.name || 'Guest') + (member.id === state.snapshot.you ? ' (you)' : '');
      const role = document.createElement('span');
      role.className = 'wp-member-role';
      role.textContent = member.host ? (member.online ? 'HOST' : 'HOST · AWAY') : (member.online ? 'ONLINE' : 'AWAY');
      item.append(avatar, name, role);
      ui.members.appendChild(item);
    });
  }
  function renderMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const key = list.map((m) => m.id).join(',');
    if (key === state.lastMessageKey) return;
    const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 80;
    state.lastMessageKey = key;
    ui.messages.textContent = '';
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'wp-empty-chat';
      empty.textContent = 'Say hello to your party.';
      ui.messages.appendChild(empty);
    }
    list.forEach((message) => {
      const item = document.createElement('div');
      item.className = 'wp-message';
      const name = document.createElement('strong');
      name.textContent = String(message.name || 'Guest');
      const body = document.createElement('p');
      body.textContent = String(message.body || '');
      item.append(name, body);
      ui.messages.appendChild(item);
    });
    if (nearBottom) ui.messages.scrollTop = ui.messages.scrollHeight;
  }
  function renderSourceStatus() {
    if (!state.snapshot || !state.snapshot.room) return;
    const room = state.snapshot.room;
    const supported = players.supportsSource(room.provider);
    ui.sourceSettings.hidden = !supported;
    if (!supported) return;
    const configured = typeof room.source_sync === 'boolean';
    const enabled = configured && room.source_sync;
    const target = players.normalizeSource(room.provider, room.source_id);
    const local = state.player && state.player.source || '';
    ui.sourceSync.checked = enabled;
    ui.sourceSync.disabled = !configured || !state.isHost || state.sourceSyncChanging || state.switchingProvider || state.episodeChanged;
    if (!configured) {
      ui.sourceStatus.textContent = 'Server matching requires the updated party service.';
    } else if (state.episodeChanged) {
      ui.sourceStatus.textContent = 'Server matching is paused after changing episodes. Reload the party player.';
    } else if (!enabled) {
      ui.sourceStatus.textContent = 'Automatic server matching is off.';
    } else if (state.isHost && state.player && state.player.sourceReported && !local) {
      ui.sourceStatus.textContent = 'The host player reported an unrecognized server. Automatic matching is unavailable for it.';
    } else if (state.isHost && state.player && state.player.sourceRetryAt > Date.now()) {
      ui.sourceStatus.textContent = 'Could not share the server choice. Retrying…';
    } else if (!target) {
      ui.sourceStatus.textContent = 'Waiting for the host player to report its server. ' +
        (state.isHost ? 'Choose a server inside the player if needed.' : 'Ask the host to choose a server inside their player.');
    } else if (state.isHost) {
      ui.sourceStatus.textContent = local === target
        ? 'Host server: ' + players.sourceLabel(room.provider, target) + '. Guests will try this server.'
        : 'Sharing the host’s server choice…';
    } else if (local === target) {
      ui.sourceStatus.textContent = 'Player reports the host’s server: ' + players.sourceLabel(room.provider, target) + '.';
    } else if (state.player && state.player.sourceReported) {
      const actual = local ? players.sourceLabel(room.provider, local) : 'an unrecognized server';
      ui.sourceStatus.textContent = 'Host: ' + players.sourceLabel(room.provider, target) + '; yours: ' + actual +
        '. The player may have fallen back. Use Resync to retry.';
    } else {
      ui.sourceStatus.textContent = 'Requesting the host’s server: ' + players.sourceLabel(room.provider, target) + '…';
    }
  }

  function reconcileGuestSource(room) {
    if (state.isHost || !state.player || state.episodeChanged || !players.supportsSource(room.provider)) return;
    if (!room.source_sync) { state.player.sourceAttempt = ''; return; }
    const target = players.normalizeSource(room.provider, room.source_id);
    if (!target) { state.player.sourceAttempt = ''; return; }
    if (state.player.source === target) {
      // Record a host change even when the guest already happens to be on it.
      // If the host later returns to an earlier failed choice, retry once.
      state.player.sourceAttempt = target;
      return;
    }
    if (state.player.sourceAttempt === target) return;
    // CineSrc/BingeAPI document a preferred source at load, not a runtime
    // setter. Reload once per host choice; do not loop if it falls back.
    loadPlayer(room);
  }

  function publishSource(source) {
    if (!state.code || !state.isHost || !state.snapshot || !state.client || state.switchingProvider || state.sourceSyncChanging) return;
    const room = state.snapshot.room;
    const provider = room.provider;
    const player = state.player;
    if (!room.source_sync || !player || !player.sourceReported || player.sourceRetryAt > Date.now()) return;
    const value = players.normalizeSource(provider, source) || null;
    if (state.sourcePending && state.sourcePending.provider === provider && state.sourcePending.value === value) return;
    if (!state.sourcePending && (players.normalizeSource(provider, room.source_id) || null) === value) return;
    const request = { code: state.code, generation: state.generation, provider, value };
    state.sourcePending = request;
    state.hostQueue = state.hostQueue.catch(() => {}).then(async () => {
      if (state.code !== request.code || state.generation !== request.generation || !state.isHost || state.provider !== provider || state.episodeChanged) return;
      // An unknown source clears the previous choice rather than falsely
      // telling guests that the old server is still active.
      await rpc(state.client, 'zeus_party_set_source', {
        p_code: request.code, p_provider: provider, p_source: value, p_enabled: true
      });
      if (state.player === player && (players.normalizeSource(provider, player.source) || null) === value) player.sourceRetryAt = 0;
      scheduleRefresh();
    }).catch(() => {
      if (state.code === request.code && state.generation === request.generation && state.player === player &&
          (players.normalizeSource(provider, player.source) || null) === value) {
        player.sourceRetryAt = Date.now() + 5000;
        ui.sourceStatus.textContent = 'Could not share the server choice. Retrying…';
      }
    }).finally(() => {
      if (state.sourcePending === request) state.sourcePending = null;
    });
  }

  async function toggleSourceSync() {
    if (!state.code || !state.isHost || !state.snapshot || state.sourceSyncChanging || state.switchingProvider || !players.supportsSource(state.provider)) return;
    const enabled = ui.sourceSync.checked;
    const code = state.code;
    const generation = state.generation;
    const provider = state.provider;
    state.sourceSyncChanging = true;
    ui.sourceSync.disabled = true;
    ui.provider.disabled = true;
    try {
      await state.hostQueue;
      if (state.code !== code || state.generation !== generation || state.provider !== provider) return;
      await rpc(state.client, 'zeus_party_set_source', {
        p_code: code, p_provider: provider,
        p_source: enabled && state.player ? state.player.source || null : null, p_enabled: enabled
      });
      await refresh();
    } catch (error) {
      if (state.code === code && state.generation === generation) playerNotice('Could not change server matching. Please retry.');
    } finally {
      if (state.code === code && state.generation === generation) {
        state.sourceSyncChanging = false;
        ui.provider.disabled = !state.isHost || state.switchingProvider;
        renderSourceStatus();
        if (enabled && state.player) publishSource(state.player.source);
      }
    }
  }

  function hostOnline() {
    return !!state.snapshot && Array.isArray(state.snapshot.members) &&
      state.snapshot.members.some((member) => member.host && member.online);
  }
  function roomConnectionFresh(now) {
    return state.connectionKind !== 'error' && !!state.lastSnapshotAt && now - state.lastSnapshotAt < 16000;
  }
  function renderVidoraGuide() {
    const active = !!state.code && !!state.snapshot && state.provider === 'vidora';
    ui.vidoraGuide.hidden = !active;
    ui.stageStatus.hidden = !active;
    if (!active) return;
    const now = Date.now();
    const room = state.snapshot.room;
    const clock = players.vidoraClock(room, state.serverOffset, now);
    const connected = roomConnectionFresh(now);
    const online = hostOnline();
    const usable = clock.status === 'ready' && connected && online;
    const local = state.player;
    let localTime = null;
    if (local && !state.episodeChanged && local.time !== null) {
      const age = Math.max(0, (now - local.lastTimeAt) / 1000);
      if (local.paused === true) localTime = local.time;
      else if (age <= 5) localTime = local.time + (local.paused === false ? age : 0);
    }
    ui.localClock.textContent = localTime === null ? 'Your Vidora: waiting for a player event' :
      'Your Vidora: ' + (local.paused === true ? 'paused at ' : local.paused === false ? 'playing at ~' : 'at ~') + players.formatTime(localTime);
    ui.resync.textContent = state.episodeChanged ? 'Reload room episode' : state.isHost
      ? 'Reload my Vidora player' : usable ? 'Try reload at host time' : 'Reload my Vidora player';
    ui.resync.disabled = false;

    if (state.episodeChanged) {
      ui.hostClock.textContent = 'This player’s media is not confirmed';
      ui.stageStatus.textContent = 'Check media';
      ui.vidoraAdvice.textContent = 'Return to the room’s movie or episode. Playback and server selection remain manual.';
    } else if (typeof room.vidora_observed !== 'boolean') {
      ui.hostClock.textContent = 'Progress sharing unavailable';
      ui.stageStatus.textContent = 'Manual';
      ui.vidoraAdvice.textContent = 'The party service needs its Vidora update. Each viewer can still control Vidora manually.';
    } else if (!connected) {
      ui.hostClock.textContent = 'Room connection interrupted';
      ui.stageStatus.textContent = 'Reconnecting';
      ui.vidoraAdvice.textContent = 'The last room update may be stale. Reconnecting; control Vidora manually.';
    } else if (!online) {
      ui.hostClock.textContent = 'Host is away';
      ui.stageStatus.textContent = 'Host away';
      ui.vidoraAdvice.textContent = 'Wait for the host to return and report their player again.';
    } else if (clock.status === 'waiting') {
      ui.hostClock.textContent = 'Waiting for the host’s Vidora player';
      ui.stageStatus.textContent = 'Waiting for host';
      ui.vidoraAdvice.textContent = state.isHost
        ? 'Play or pause in Vidora to share your position. Guests follow manually.'
        : 'Ask the host to play or pause in Vidora. You control your own player.';
    } else if (clock.status === 'stale') {
      ui.hostClock.textContent = 'Last host update: ' + players.formatTime(clock.time);
      ui.stageStatus.textContent = 'Waiting for update';
      ui.vidoraAdvice.textContent = 'Host progress has stopped updating. Do not rely on this time until a new event arrives.';
    } else {
      const time = players.formatTime(clock.time);
      ui.hostClock.textContent = 'Host ' + (room.playing ? 'playing at ~' : 'paused at ') + time;
      ui.stageStatus.textContent = (room.playing ? 'Host ~' : 'Paused ') + time;
      if (state.isHost) {
        ui.vidoraAdvice.textContent = 'Your player reports its time to the room. Guests must play, pause and seek manually.';
      } else if (!local || localTime === null || local.paused === null) {
        ui.vidoraAdvice.textContent = 'In Vidora, ' + (room.playing ? 'press play' : 'pause') + ' and seek to the host time. Times are approximate.';
      } else if (room.playing && local.paused) {
        ui.vidoraAdvice.textContent = 'The host is playing. Press play in Vidora and seek to the host time.';
      } else if (!room.playing && !local.paused) {
        ui.vidoraAdvice.textContent = 'The host paused. Pause Vidora and seek to the host time.';
      } else if (Math.abs(localTime - clock.time) >= 3) {
        ui.vidoraAdvice.textContent = 'Your player is about ' + Math.round(Math.abs(localTime - clock.time)) + ' seconds ' +
          (localTime < clock.time ? 'behind' : 'ahead') + '. Seek manually to the host time.';
      } else {
        ui.vidoraAdvice.textContent = 'Times appear close. Vidora does not automatically keep them aligned.';
      }
    }
  }

  function applySnapshot(snapshot, started, ended) {
    if (!snapshot || !snapshot.room || snapshot.room.code !== state.code) return;
    state.lastSnapshotAt = ended;
    const serverNow = Date.parse(snapshot.server_now);
    if (Number.isFinite(serverNow)) state.serverOffset = serverNow - (started + ended) / 2;
    state.snapshot = snapshot;
    state.isHost = snapshot.you === snapshot.room.host_id;
    if (snapshot.room.ended) {
      playerNotice('The host ended this party.');
      finishRoom('This party has ended.');
      return;
    }
    ui.role.textContent = state.isHost ? 'YOU ARE THE HOST' : 'YOU ARE A GUEST';
    ui.roomCode.textContent = players.formatCode(state.code);
    ui.provider.value = snapshot.room.provider;
    ui.provider.disabled = !state.isHost || state.sourceSyncChanging || state.switchingProvider;
    if (snapshot.room.provider === 'vidora') {
      ui.providerHint.textContent = 'Vidora shares host progress, but play, pause, seek and server selection are manual on each device. Reloading tries a starting time; saved progress may override it.';
    } else if (snapshot.room.provider === 'vidspark') {
      ui.providerHint.textContent = 'VidSpark does not expose its internal server choice. ' +
        (state.isHost ? 'Changing party player pauses the room.' : 'Only the host controls the room.');
    } else if (snapshot.room.provider === 'bingeapi') {
      ui.providerHint.textContent = 'BingeAPI is experimental. Up to 4K and subtitle availability vary by title, server and language. Server matching is best-effort.';
    } else {
      ui.providerHint.textContent = state.isHost
        ? 'Changing player pauses the room. Server matching is best-effort.'
        : 'Only the host can change the player or control the room.';
    }
    ui.resync.hidden = false;
    if (snapshot.room.provider !== 'vidora') ui.resync.disabled = false;
    ui.end.hidden = !state.isHost;
    renderMembers(snapshot.members);
    renderMessages(snapshot.messages);
    if (state.provider !== snapshot.room.provider) {
      loadPlayer(snapshot.room, { preserve: state.preservePlayer && snapshot.room.provider === 'vidora' });
      state.preservePlayer = false;
    } else if (!state.isHost && snapshot.room.provider !== 'vidora') {
      reconcileGuestSource(snapshot.room);
      followHost(false);
    } else if (state.isHost && state.player && !state.episodeChanged) {
      // Also retries a source update after a transient network error.
      publishSource(state.player.source);
    }
    renderSourceStatus();
    renderVidoraGuide();
  }

  function loadPlayer(room, options) {
    const now = Date.now();
    const frame = document.getElementById('player-frame');
    const previous = state.provider === 'vidora' ? state.player : null;
    const preserve = !!(options && options.preserve && room.provider === 'vidora');
    const cached = preserve && state.normalVidora && state.normalVidora.frameSrc === frame.src ? state.normalVidora : null;
    const clock = players.vidoraClock(room, state.serverOffset, now);
    // startAt is just a request, not a seek: saved Vidora progress can win.
    // Avoid projecting a disconnected or stale host clock into a new player.
    let start = players.targetTime(room, state.serverOffset, now);
    if (room.provider === 'vidora') {
      const available = clock.status === 'ready' && hostOnline() && roomConnectionFresh(now);
      start = state.isHost && previous && previous.time !== null ? previous.time :
        available ? clock.time : previous && previous.time !== null ? previous.time : 0;
    }
    state.enforceSwitchPause = !!state.provider && state.provider !== room.provider;
    if (state.provider !== room.provider) state.sourcePending = null;
    state.provider = room.provider;
    state.player = {
      time: cached ? cached.time : null, paused: cached ? cached.paused : null,
      lastTimeAt: cached ? cached.lastTimeAt : 0, lastEventAt: cached ? cached.lastEventAt : 0,
      suppressedUntil: 0, startedAt: now, vidoraReady: preserve, vidoraPublished: false, vidoraAwaitingTime: false,
      source: '', sourceReported: false, sourceRetryAt: 0, commandReady: false, errorNotice: '',
      sourceAttempt: room.source_sync ? players.normalizeSource(room.provider, room.source_id) : ''
    };
    state.normalVidora = null;
    state.vidoraNeedsRetry = false;
    state.vidoraNeedsClear = false;
    state.initialApplied = false;
    state.episodeChanged = false;
    ui.resync.textContent = 'Resync my player';
    state.lastSeek = 0;
    state.lastPlayCommand = 0;
    state.playAttempts = 0;
    state.lastHostSync = 0;
    playerNotice(room.provider === 'vidora'
      ? 'Vidora playback is not automatically synchronized. Each viewer controls their own player.'
      : 'Waiting for ' + (players.LABELS[room.provider] || 'the player') + '. If needed, click inside the player.');
    try {
      if (!preserve) {
        if (room.provider === 'vidora') {
          const player = state.player;
          frame.addEventListener('load', () => {
            if (state.player === player && state.provider === 'vidora') player.vidoraReady = true;
          }, { once: true });
        }
        frame.src = players.buildUrl(room, start);
      }
      if (room.provider === 'vidora' && state.isHost) {
        if (room.vidora_observed === true || previous) queueVidora('clear', start);
        if (cached && cached.time !== null && cached.paused !== null &&
            (cached.paused || now - cached.lastTimeAt < 5000)) {
          const time = cached.time + (!cached.paused ? Math.max(0, now - cached.lastTimeAt) / 1000 : 0);
          state.player.vidoraPublished = true;
          state.lastHostSync = now;
          queueVidora(cached.paused ? 'sync_pause' : 'sync_play', time);
        }
      }
    } catch (error) {
      playerNotice('This party player could not be loaded. Ask the host to choose another player.');
    }
    renderVidoraGuide();
  }
  function command(action, time) {
    const frame = document.getElementById('player-frame');
    players.send(frame, state.provider, action, time);
  }
  function followHost(force) {
    if (!state.code || !state.snapshot || !state.player || state.isHost || state.episodeChanged ||
        (!state.initialApplied && !state.player.commandReady) || state.provider === 'vidora') return;
    const now = Date.now();
    const room = state.snapshot.room;
    const target = players.targetTime(room, state.serverOffset, now);
    // Extrapolate a recent local measurement while the player is running,
    // otherwise the one-second timeupdate cadence itself looks like drift.
    const localTime = state.player.time === null ? null : state.player.time +
      (state.player.paused === false ? Math.min(4, Math.max(0, (now - state.player.lastTimeAt) / 1000)) : 0);
    const drift = localTime === null ? Infinity : Math.abs(localTime - target);
    if ((force || drift > DRIFT_SECONDS) && now - state.lastSeek > 2500) {
      command('seek', target);
      state.lastSeek = now;
    }
    const needsPlay = state.player.paused === null || state.player.paused === room.playing;
    if ((force || needsPlay) && now - state.lastPlayCommand > 2800) {
      command(room.playing ? 'play' : 'pause');
      state.lastPlayCommand = now;
      if (room.playing && needsPlay) state.playAttempts += 1;
    }
    const hostOnline = Array.isArray(state.snapshot.members) && state.snapshot.members.some((member) => member.host && member.online);
    if (state.player.errorNotice) {
      playerNotice(state.player.errorNotice);
    } else if (!hostOnline) {
      playerNotice('The host is away. The room is paused until they return.');
    } else if (room.playing && state.playAttempts >= 3 && state.player.paused !== false) {
      playerNotice('Playback may be blocked. Click inside the player to allow it, then use Resync.');
    } else if (state.player.lastEventAt) {
      playerNotice('Trying to follow the host. If playback stalls, click inside the player or use Resync.');
    }
  }
  function queueHost(action, time) {
    if (!state.code || !state.isHost || !state.client || state.switchingProvider) return;
    const position = players.finiteTime(time);
    if (position === null) return;
    const code = state.code;
    const generation = state.generation;
    state.hostQueue = state.hostQueue.catch(() => {}).then(async () => {
      if (state.code !== code || generation !== state.generation || !state.isHost) return;
      await rpc(state.client, 'zeus_party_playback', { p_code: code, p_action: action, p_time: position });
      scheduleRefresh();
    }).catch(() => {
      if (state.code === code) setConnection('Connection lost · retrying', 'error');
    });
  }
  function queueVidora(action, time) {
    if (!state.code || !state.isHost || !state.client || state.provider !== 'vidora' || !state.player) return;
    const position = players.finiteTime(time);
    if (position === null) return;
    if (action === 'clear') state.vidoraClearTime = position;
    const code = state.code;
    const generation = state.generation;
    const player = state.player;
    state.hostQueue = state.hostQueue.catch(() => {}).then(async () => {
      if (state.code !== code || state.generation !== generation || !state.isHost || state.provider !== 'vidora' ||
          state.player !== player || (state.episodeChanged && action !== 'clear')) return;
      await rpc(state.client, 'zeus_party_vidora_update', { p_code: code, p_action: action, p_time: position });
      if (state.code === code && state.generation === generation && state.player === player) {
        const recovered = state.vidoraNeedsRetry || state.vidoraNeedsClear;
        state.vidoraNeedsRetry = false;
        state.vidoraNeedsClear = false;
        if (recovered) {
          playerNotice(state.episodeChanged
            ? 'Vidora’s media is not confirmed. Reload the room episode; playback is manual.'
            : 'Vidora playback is not automatically synchronized. Each viewer controls their own player.');
        }
        scheduleRefresh();
      }
    }).catch(() => {
      if (state.code === code && state.generation === generation && state.player === player && state.provider === 'vidora') {
        if (action === 'clear') state.vidoraNeedsClear = true;
        else state.vidoraNeedsRetry = true;
        state.lastVidoraRetry = Date.now();
        setConnection('Connection lost · retrying', 'error');
        playerNotice('Could not share Vidora progress. Retrying; everyone still controls their own player.');
      }
    });
  }

  // Remember only documented, origin-checked observations from the normal
  // Vidora player. Starting a Vidora room can then leave that iframe playing
  // instead of interrupting it, and share a fresh known play/pause state.
  function observeNormalVidora(event) {
    const frame = document.getElementById('player-frame');
    const received = players.readEvent(event, frame, 'vidora');
    if (!received) return;
    const media = bridge.getMedia();
    if (players.vidoraMediaMatch(event.data.data, media) !== 'match') { state.normalVidora = null; return; }
    const now = Date.now();
    let cached = state.normalVidora;
    if (!cached || cached.frameSrc !== frame.src) {
      cached = { frameSrc: frame.src, time: null, paused: null, lastTimeAt: 0, lastEventAt: 0 };
      state.normalVidora = cached;
    }
    if (received.time !== null) { cached.time = received.time; cached.lastTimeAt = now; }
    else if (['play', 'pause', 'ended', 'seeked'].includes(received.kind)) { cached.time = null; cached.lastTimeAt = 0; }
    if (received.paused !== null) cached.paused = received.paused;
    if (received.time !== null || received.paused !== null) cached.lastEventAt = now;
  }

  function onPlayerMessage(event) {
    if (!state.code) { observeNormalVidora(event); return; }
    if (!state.player || !state.snapshot) return;
    const frame = document.getElementById('player-frame');
    const received = players.readEvent(event, frame, state.provider);
    if (!received) return;
    if (received.kind === 'nextepisode') {
      // Do not replace CineSrc's iframe during its internal navigation. Stop
      // sharing its events and let the viewer explicitly return to the room.
      state.episodeChanged = true;
      ui.resync.textContent = 'Reload party player';
      playerNotice('This player changed episodes locally. Reload the party player to return to the shared episode.');
      renderSourceStatus();
      return;
    }
    if (state.episodeChanged && state.provider !== 'vidora') return;
    if (received.kind === 'sourceused') {
      if (state.player.source !== received.sourceId) state.player.sourceRetryAt = 0;
      state.player.sourceReported = true;
      state.player.source = received.sourceId;
      if (state.isHost) publishSource(received.sourceId);
      renderSourceStatus();
      if (state.provider === 'bingeapi' && !state.initialApplied && !state.player.commandReady) {
        // The first server event means commands can be attempted, not that
        // the source is playable. BingeAPI has no status getter and a seek
        // need not produce an event, so do not wait for one before following.
        state.player.commandReady = true;
        if (state.isHost) {
          const room = state.snapshot.room;
          command('seek', players.targetTime(room, state.serverOffset, Date.now()));
          if (room.playing) command('play');
        } else followHost(true);
      }
      return;
    }
    if (received.kind === 'error') {
      // Show enough of the provider's message to diagnose a failing source,
      // without exposing a potentially signed stream URL in the panel.
      const detail = String(received.error || 'Player error').replace(/https?:\/\/\S+/gi, '[link omitted]')
        .replace(/\s+/g, ' ').trim().slice(0, 140);
      state.player.errorNotice = (players.LABELS[state.provider] || 'Player') + ': ' + detail +
        '. The player may try another server; use Resync to retry or ask the host to switch players.';
      playerNotice(state.player.errorNotice);
      return;
    }
    if (state.player.errorNotice &&
        (received.kind === 'play' || (received.kind === 'timeupdate' && received.time !== null && received.time > 0))) {
      state.player.errorNotice = '';
      if (state.isHost) playerNotice('You control playback for the room.');
    }
    if (state.provider === 'vidora') {
      if (!state.player.vidoraReady) return;
      const identity = players.vidoraMediaMatch(event.data.data, state.snapshot.room);
      if (identity !== 'match') {
        if (!state.episodeChanged && state.isHost) {
          queueVidora('clear', state.player.time ?? players.finiteTime(state.snapshot.room.position_seconds) ?? 0);
        }
        state.episodeChanged = true;
        state.player.time = null;
        state.player.paused = null;
        state.player.lastTimeAt = 0;
        state.player.vidoraPublished = false;
        state.player.vidoraAwaitingTime = false;
        playerNotice(identity === 'different'
          ? 'Vidora changed media or episodes locally. Reload the room episode; playback is manual.'
          : 'Vidora did not identify this movie or episode. Progress cannot be shared until it is confirmed.');
        renderVidoraGuide();
        return;
      }
      if (state.episodeChanged) {
        state.episodeChanged = false;
        state.player.time = null;
        state.player.paused = null;
        state.player.lastTimeAt = 0;
        state.player.vidoraPublished = false;
        state.player.vidoraAwaitingTime = false;
      }
      if (!state.vidoraNeedsRetry && !state.vidoraNeedsClear) {
        playerNotice('Vidora playback is not automatically synchronized. Each viewer controls their own player.');
      }
    }
    const now = Date.now();
    // A mere iframe/ready event is not evidence that a playable source exists.
    if (received.time !== null || received.paused !== null) state.player.lastEventAt = now;
    if (received.time !== null) { state.player.time = received.time; state.player.lastTimeAt = now; }
    if (received.paused !== null) state.player.paused = received.paused;
    if (state.provider === 'vidora') {
      // Share observations only. There is no documented inbound Vidora
      // play/pause/seek command, so guests always control their own iframe.
      if (received.time === null && ['play', 'pause', 'ended', 'seeked'].includes(received.kind)) {
        // Never pair a new action with an old position if the provider omits
        // its documented timestamp; wait for a valid subsequent event.
        state.player.time = null;
        state.player.lastTimeAt = 0;
        state.player.vidoraAwaitingTime = true;
        playerNotice('Vidora did not report a valid time. Waiting for another player event; playback remains manual.');
      }
      if (state.isHost && received.time !== null && state.player.paused !== null) {
        const action = received.kind === 'play' ? 'play' :
          received.kind === 'pause' || received.kind === 'ended' ? 'pause' :
            received.kind === 'seeked' || !state.player.vidoraPublished || state.player.vidoraAwaitingTime
              ? (state.player.paused ? 'sync_pause' : 'sync_play') : '';
        if (action) {
          state.player.vidoraPublished = true;
          state.player.vidoraAwaitingTime = false;
          state.lastHostSync = now;
          queueVidora(action, received.time);
        }
      }
      if (!state.isHost && received.time !== null) state.player.vidoraAwaitingTime = false;
      renderVidoraGuide();
      return;
    }
    if (!state.initialApplied && (received.time !== null || received.paused !== null)) {
      state.initialApplied = true;
      const room = state.snapshot.room;
      const target = players.targetTime(room, state.serverOffset, now);
      if (state.isHost) {
        state.player.suppressedUntil = now + 1200;
        // A status response may describe the player before this initial seek.
        // Do not use that old measurement as the time of a later play/pause.
        state.player.time = null;
        state.player.lastTimeAt = 0;
        command('seek', target);
        if (received.kind === 'play' && !room.playing && !state.enforceSwitchPause) {
          // A host can press play before the first status poll. Treat that
          // first play as authoritative rather than swallowing the click,
          // and do not suppress an immediate subsequent pause.
          state.player.suppressedUntil = 0;
          queueHost('play', target);
        } else {
          command(room.playing ? 'play' : 'pause');
        }
        state.enforceSwitchPause = false;
        if (!state.player.errorNotice) playerNotice('You control playback for the room. Click inside the player to start.');
      } else followHost(true);
      return;
    }
    if (state.isHost) {
      const action = received.kind === 'ended' ? 'pause' : received.kind;
      if (now < state.player.suppressedUntil) {
        // Ignore only echoes of our initial commands, not an immediate real
        // host play/pause or a seek to a different position.
        const room = state.snapshot.room;
        const target = players.targetTime(room, state.serverOffset, now);
        const echo = (action === 'play' && room.playing) || (action === 'pause' && !room.playing) ||
          (action === 'seeked' && state.player.time !== null && Math.abs(state.player.time - target) < DRIFT_SECONDS);
        if (echo) return;
        // Once a different host action is observed, the old snapshot can no
        // longer distinguish echoes from the host's next quick action.
        if (['play', 'pause', 'seeked'].includes(action)) state.player.suppressedUntil = 0;
      }
      if (['play', 'pause', 'seeked'].includes(action)) {
        // CineSrc and BingeAPI play/pause events do not contain a time. Until
        // the player reports one, preserve the room clock instead of jumping
        // a resumed room to zero. A seek without a position is not actionable.
        if (action === 'seeked' && received.time === null) return;
        const position = state.player.time ?? players.targetTime(state.snapshot.room, state.serverOffset, now);
        queueHost(action === 'seeked' ? 'seek' : action, position);
      }
    } else if (state.initialApplied) {
      if (state.player.paused === false) state.playAttempts = 0;
      followHost(false);
    }
  }
  function checkPlayer() {
    if (!state.code || !state.player || !state.snapshot) return;
    const now = Date.now();
    if (state.provider === 'vidora') {
      renderVidoraGuide();
      if (state.isHost && state.vidoraNeedsClear && now - state.lastVidoraRetry >= 5000) {
        state.lastVidoraRetry = now;
        queueVidora('clear', state.vidoraClearTime);
      } else if (state.isHost && !state.episodeChanged && state.player.time !== null && state.player.paused !== null) {
        const recent = state.player.paused || now - state.player.lastTimeAt < 5000;
        const retry = state.vidoraNeedsRetry && now - state.lastVidoraRetry >= 5000;
        const periodic = !state.player.paused && now - state.lastHostSync >= 8000;
        if (recent && (retry || periodic)) {
          state.lastHostSync = state.lastVidoraRetry = now;
          const time = Math.min(86400, state.player.time + (!state.player.paused ? Math.max(0, now - state.player.lastTimeAt) / 1000 : 0));
          queueVidora(state.player.paused ? 'sync_pause' : 'sync_play', time);
        }
      }
      if (!state.episodeChanged && !state.vidoraNeedsRetry && !state.vidoraNeedsClear &&
          !state.player.lastEventAt && now - state.player.startedAt > 14000) {
        playerNotice('Vidora has not sent playback events. Try playing inside it; the source may be unavailable.');
      }
      return;
    }
    if (state.episodeChanged) return;
    command('status');
    if (state.isHost && state.initialApplied && state.player.time !== null && state.player.paused !== null &&
        now - state.player.lastTimeAt < 5000 && now - state.lastHostSync > 8000 && now > state.player.suppressedUntil) {
      state.lastHostSync = now;
      queueHost(state.player.paused ? 'sync_pause' : 'sync_play', state.player.time);
    }
    if (!state.isHost && (state.initialApplied || state.player.commandReady)) followHost(false);
    if (!state.player.errorNotice && !state.player.lastEventAt && now - state.player.startedAt > 14000) {
      playerNotice('The player has not responded. Click inside it or use Resync to reload; the host can also switch players.');
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const body = String(ui.chatInput.value || '').trim();
    if (!body || !state.code) return;
    ui.send.disabled = true;
    ui.chatError.textContent = '';
    try {
      await rpc(state.client, 'zeus_party_chat', { p_code: state.code, p_body: body });
      ui.chatInput.value = '';
      scheduleRefresh();
    } catch (error) { ui.chatError.textContent = friendlyError(error); }
    finally { ui.send.disabled = false; }
  }
  async function switchProvider() {
    if (!state.code || !state.isHost || !state.snapshot || state.switchingProvider || state.sourceSyncChanging) return;
    const provider = ui.provider.value;
    if (provider === state.provider) return;
    ui.provider.disabled = true;
    ui.sourceSync.disabled = true;
    state.switchingProvider = true;
    const code = state.code;
    const generation = state.generation;
    try {
      // Keep provider changes ordered after the host's pending playback events.
      await state.hostQueue;
      if (state.code !== code || state.generation !== generation || !state.isHost || !state.snapshot) return;
      await rpc(state.client, 'zeus_party_set_provider', {
        p_code: code, p_provider: provider,
        p_time: players.finiteTime(state.player && state.player.time) ?? players.targetTime(state.snapshot.room, state.serverOffset, Date.now())
      });
      if (state.code === code && state.generation === generation) await refresh();
    } catch (error) {
      if (state.code === code && state.generation === generation) {
        if (state.snapshot) ui.provider.value = state.snapshot.room.provider;
        playerNotice(friendlyError(error));
      }
    } finally {
      if (state.code === code && state.generation === generation) {
        state.switchingProvider = false;
        ui.provider.disabled = !state.isHost || state.sourceSyncChanging;
        if (state.snapshot) renderSourceStatus();
        if (state.player && state.provider === provider) publishSource(state.player.source);
      }
    }
  }
  async function leave(end) {
    if (!state.code) return;
    if (end && !window.confirm('End this party for everyone?')) return;
    const code = state.code;
    ui.leave.disabled = true;
    ui.end.disabled = true;
    try {
      await rpc(state.client, end ? 'zeus_party_end' : 'zeus_party_leave', { p_code: code });
      finishRoom(end ? 'Party ended.' : 'You left the party.');
    } catch (error) {
      if (!end) finishRoom('Left on this device. The room may take a moment to show you as away.');
      else playerNotice('Could not end the room. Reconnect and try again, or leave on this device.');
    } finally { ui.leave.disabled = false; ui.end.disabled = false; }
  }
  function finishRoom(message) {
    state.generation += 1;
    clearTimeout(state.refreshTimer);
    clearTimeout(state.channelRetry);
    state.channelRetry = null;
    clearInterval(state.pollTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.statusTimer);
    clearInterval(state.displayTimer);
    state.refreshTimer = state.pollTimer = state.heartbeatTimer = state.statusTimer = state.displayTimer = null;
    if (state.client && state.channel) state.client.removeChannel(state.channel);
    state.channel = null;
    state.code = '';
    state.snapshot = null;
    state.provider = '';
    state.player = null;
    state.live = false;
    state.isHost = false;
    state.switchingProvider = false;
    state.sourceSyncChanging = false;
    state.sourcePending = null;
    state.refreshAgain = false;
    state.hostQueue = Promise.resolve();
    state.normalVidora = null;
    state.vidoraNeedsRetry = state.vidoraNeedsClear = false;
    state.lastSnapshotAt = 0;
    removeSession(ACTIVE_KEY);
    setAddressCode('');
    ui.room.hidden = true;
    ui.welcome.hidden = false;
    ui.panel.querySelector('.wp-panel-inner').scrollTop = 0;
    ui.button.classList.remove('wp-active');
    ui.stageButton.classList.remove('wp-active');
    ui.stageStatus.hidden = true;
    ui.vidoraGuide.hidden = true;
    syncFullscreenButton();
    ui.codeInput.value = '';
    showError(message);
    bridge.exit();
  }

  function syncFullscreenButton() {
    const active = document.fullscreenElement === ui.shell;
    ui.fullscreen.hidden = !active && (!state.code || typeof ui.shell.requestFullscreen !== 'function');
    ui.fullscreen.setAttribute('aria-label', active ? 'Exit player fullscreen' : 'Open player fullscreen');
    ui.fullscreen.title = active ? 'Exit player fullscreen' : 'Open ZEUS player fullscreen to keep the party overlay visible';
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === ui.shell) await document.exitFullscreen();
      else if (typeof ui.shell.requestFullscreen === 'function') await ui.shell.requestFullscreen();
    } catch (error) {
      if (state.code) playerNotice('Fullscreen is unavailable on this device. The party panel still works on the page.');
    }
  }

  function mount() {
    const shell = document.getElementById('player-shell');
    const mountPoint = shell && shell.querySelector('.chrome-right');
    const player = document.getElementById('player-wrapper');
    if (!shell || !mountPoint || !player) return;
    const button = document.createElement('button');
    button.id = 'watch-party-btn';
    button.type = 'button';
    button.className = 'chrome-btn chrome-btn--watchparty';
    button.setAttribute('aria-controls', 'wp-panel');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13Zm8 0c-.4 0-.7 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5Z"/></svg><span>Watch Party</span>';
    mountPoint.appendChild(button);
    const workspace = document.createElement('div');
    workspace.className = 'wp-workspace';
    player.parentNode.insertBefore(workspace, player);
    workspace.appendChild(player);
    // This is ZEUS chrome layered over the cross-origin iframe, not code
    // injected into Vidora. The iframe's own fullscreen cannot show it.
    const stageTools = document.createElement('div');
    stageTools.className = 'wp-stage-tools';
    stageTools.innerHTML = `<button class="wp-stage-button" type="button" aria-controls="wp-panel" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13Zm8 0c-.4 0-.7 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5Z"/></svg>
      <span>Party</span><span class="wp-stage-status" hidden></span></button>
      <button class="wp-fullscreen" type="button" aria-label="Open player fullscreen" title="Open player fullscreen" hidden>⛶</button>`;
    player.appendChild(stageTools);
    const panel = document.createElement('aside');
    panel.className = 'wp-panel';
    panel.id = 'wp-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Watch Party');
    panel.innerHTML = `
      <div class="wp-panel-inner">
        <div class="wp-heading"><div><span class="wp-kicker">WATCH TOGETHER</span><h2>Watch Party</h2></div>
          <button class="wp-close" type="button" aria-label="Close party panel">×</button></div>
        <div class="wp-welcome">
          <div class="wp-intro-icon" aria-hidden="true">✦</div>
          <h3>Better together.</h3><p>Bring your people along. Controls depend on the selected player.</p>
          <p class="wp-error" role="status" hidden></p>
          <label for="wp-name">YOUR NAME</label><input id="wp-name" maxlength="32" autocomplete="nickname" placeholder="Enter your name">
          <label for="wp-create-provider">PARTY PLAYER</label>
          <select id="wp-create-provider"><option value="vidora">Vidora (manual follow)</option><option value="vidspark">VidSpark</option><option value="cinesrc">CineSrc</option><option value="bingeapi">BingeAPI (experimental · up to 4K)</option></select>
          <p class="wp-create-hint" role="status"></p>
          <button class="wp-primary wp-create" type="button">Start a party</button>
          <div class="wp-divider"><span>OR JOIN A PARTY</span></div>
          <form class="wp-join-form"><label class="wp-sr-only" for="wp-code-input">Party code or invitation link</label>
            <input id="wp-code-input" placeholder="Party code or invitation link" autocomplete="off" spellcheck="false">
            <button class="wp-secondary wp-join" type="submit">Join</button></form>
          <p class="wp-disclaimer">Party players are third-party sources. Playback availability and autoplay can vary by device.</p>
        </div>
        <div class="wp-room" hidden>
          <div class="wp-status-line"><span class="wp-connection" data-state="connecting">Connecting…</span><span class="wp-role"></span></div>
          <div class="wp-tabs" role="tablist" aria-label="Party panel">
            <button class="wp-party-tab" type="button" role="tab" aria-selected="true">Party</button>
            <button class="wp-chat-tab" type="button" role="tab" aria-selected="false">Chat</button>
          </div>
          <p class="wp-player-notice" role="status">Waiting for the player…</p>
          <div class="wp-vidora-guide" hidden>
            <div class="wp-vidora-heading"><span>HOST PROGRESS</span><span>MANUAL FOLLOW</span></div>
            <strong class="wp-host-clock">Waiting for the host…</strong>
            <p class="wp-local-clock">Your Vidora: waiting for a player event</p>
            <p class="wp-vidora-advice"></p>
          </div>
          <div class="wp-party-view">
            <div class="wp-source-settings" hidden>
              <label class="wp-source-toggle"><input class="wp-source-sync" type="checkbox"><span>Match host’s streaming server</span></label>
              <p class="wp-source-status" role="status"></p>
            </div>
            <div class="wp-card"><span class="wp-label">INVITE CODE</span><strong class="wp-room-code"></strong>
              <button class="wp-copy wp-secondary" type="button">Copy invite link</button><p>Anyone with this link can join. Share it with people you trust.</p></div>
            <div class="wp-section-title"><span>IN THE PARTY</span><span><span class="wp-member-count">0</span> online</span></div>
            <ul class="wp-members" aria-label="Participants"></ul>
            <label for="wp-provider">PARTY PLAYER</label>
            <select id="wp-provider"><option value="vidora">Vidora (manual follow)</option><option value="vidspark">VidSpark</option><option value="cinesrc">CineSrc</option><option value="bingeapi">BingeAPI (experimental · up to 4K)</option></select>
            <p class="wp-provider-hint"></p>
            <button class="wp-resync wp-secondary" type="button">Resync my player</button>
            <div class="wp-actions"><button class="wp-leave wp-secondary" type="button">Leave party</button>
              <button class="wp-end" type="button">End for everyone</button></div>
          </div>
          <div class="wp-chat-view" hidden>
            <div class="wp-messages" aria-live="polite"><p class="wp-empty-chat">Say hello to your party.</p></div>
            <form class="wp-chat-form"><label class="wp-sr-only" for="wp-chat-input">Message</label>
              <input id="wp-chat-input" maxlength="500" placeholder="Write a message…" autocomplete="off">
              <button class="wp-send wp-primary" type="submit">Send</button></form>
            <p class="wp-chat-error" role="status"></p>
          </div>
        </div>
      </div>`;
    workspace.appendChild(panel);
    const q = (selector) => panel.querySelector(selector);
    ui = {
      shell, button, workspace, panel, stageButton: stageTools.querySelector('.wp-stage-button'),
      stageStatus: stageTools.querySelector('.wp-stage-status'), fullscreen: stageTools.querySelector('.wp-fullscreen'),
      name: q('#wp-name'), codeInput: q('#wp-code-input'),
      vidoraGuide: q('.wp-vidora-guide'), hostClock: q('.wp-host-clock'), localClock: q('.wp-local-clock'), vidoraAdvice: q('.wp-vidora-advice'),
      createProvider: q('#wp-create-provider'), create: q('.wp-create'), join: q('.wp-join'),
      welcome: q('.wp-welcome'), room: q('.wp-room'), error: q('.wp-error'),
      connection: q('.wp-connection'), role: q('.wp-role'), roomCode: q('.wp-room-code'),
      provider: q('#wp-provider'), providerHint: q('.wp-provider-hint'), createHint: q('.wp-create-hint'),
      sourceSettings: q('.wp-source-settings'), sourceSync: q('.wp-source-sync'), sourceStatus: q('.wp-source-status'),
      end: q('.wp-end'), leave: q('.wp-leave'),
      members: q('.wp-members'), memberCount: q('.wp-member-count'), messages: q('.wp-messages'),
      chatInput: q('#wp-chat-input'), send: q('.wp-send'), chatError: q('.wp-chat-error'), playerNotice: q('.wp-player-notice'), resync: q('.wp-resync'),
      partyTab: q('.wp-party-tab'), chatTab: q('.wp-chat-tab'), partyView: q('.wp-party-view'), chatView: q('.wp-chat-view')
    };
    function updateCreateHint() {
      ui.createHint.textContent = ui.createProvider.value === 'vidora'
        ? 'Vidora shares the host’s progress; play, pause, seek and servers are controlled manually by each viewer.'
        : ui.createProvider.value === 'bingeapi'
          ? 'Experimental: BingeAPI advertises up to 4K and subtitles; availability varies by title, server and language.'
          : '';
      ui.createHint.hidden = !ui.createHint.textContent;
    }
    ui.name.value = savedName();
    updateCreateHint();
    ui.createProvider.addEventListener('change', updateCreateHint);
    button.addEventListener('click', () => setPanel(ui.panel.hidden, button));
    ui.stageButton.addEventListener('click', () => setPanel(ui.panel.hidden, ui.stageButton));
    ui.fullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFullscreenButton);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !ui.panel.hidden) setPanel(false);
    });
    q('.wp-close').addEventListener('click', () => setPanel(false));
    ui.create.addEventListener('click', () => begin('create'));
    q('.wp-join-form').addEventListener('submit', (event) => { event.preventDefault(); begin('join'); });
    ui.partyTab.addEventListener('click', () => tab('party'));
    ui.chatTab.addEventListener('click', () => tab('chat'));
    q('.wp-copy').addEventListener('click', async (event) => {
      if (!state.snapshot) return;
      const target = event.currentTarget;
      const copied = await copyText(makeInvite(state.snapshot.room));
      target.textContent = copied ? 'Invite copied' : 'Could not copy — select the address';
      setTimeout(() => { target.textContent = 'Copy invite link'; }, 2200);
    });
    ui.resync.addEventListener('click', () => {
      if (!state.snapshot || !state.player) return;
      if (state.provider === 'vidora') {
        // This is a fresh embed URL with documented startAt, not a seek or a
        // claim that Vidora accepted the requested time.
        loadPlayer(state.snapshot.room);
        refresh();
        return;
      }
      // Reload if the player failed or never responded. The host's room is
      // authoritative, so a host retry reloads instead of just requesting a
      // status (which would not recover a failed source).
      if (state.episodeChanged || !state.initialApplied || state.player.errorNotice || state.isHost) {
        loadPlayer(state.snapshot.room);
        return;
      }
      state.playAttempts = 0;
      const room = state.snapshot.room;
      const target = room.source_sync && players.normalizeSource(room.provider, room.source_id);
      if (target && state.player.source !== target) loadPlayer(room);
      else { state.lastSeek = 0; state.lastPlayCommand = 0; followHost(true); }
      refresh();
    });
    ui.provider.addEventListener('change', switchProvider);
    ui.sourceSync.addEventListener('change', toggleSourceSync);
    ui.leave.addEventListener('click', () => leave(false));
    ui.end.addEventListener('click', () => leave(true));
    q('.wp-chat-form').addEventListener('submit', sendChat);
    window.addEventListener('message', onPlayerMessage);
    document.getElementById('player-frame').addEventListener('load', () => {
      if (!state.code) state.normalVidora = null;
    });
    syncFullscreenButton();
    const invite = currentInviteCode();
    if (invite) {
      ui.codeInput.value = players.formatCode(invite);
      setPanel(true);
      try {
        const active = JSON.parse(readSession(ACTIVE_KEY) || 'null');
        if (active && active.code === invite && active.name) { ui.name.value = active.name; begin('join'); }
      } catch (error) { /* first-time invite */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
