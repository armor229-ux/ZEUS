/* Separate CineSrc-only Watch Party using the existing ZEUS Supabase room RPCs.
   The browser uses a publishable key, not a privileged service credential.
   The database checks membership and the persistent host identity. */
(function () {
  'use strict';

  const playerApi = window.ZeusCineSrcParty;
  if (!playerApi) return;

  const PROJECT_URL = 'https://gqjgmniwvqcpsurzmbet.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_74MGBFkvRcyd_uoJ1DLSnQ_yj4ap7mg';
  // Reuse the earlier party's same-tab session so an existing host can
  // reconnect without transferring authority to another participant.
  const AUTH_KEY = 'zeus_party_auth_v1';
  const ACTIVE_KEY = 'zeus_party_active_v1';
  const NAME_KEY = 'zeus_party_display_name_v1';
  const POLL_MS = 5000;
  const HEARTBEAT_MS = 18000;
  const PLAYER_POLL_MS = 2000;
  const HOST_SYNC_MS = 10000;
  const DRIFT_SECONDS = 1.6;

  const byId = id => document.getElementById(id);
  const ui = {
    lobby: byId('lobby'), room: byId('room'), createTab: byId('create-tab'), joinTab: byId('join-tab'),
    createForm: byId('create-form'), joinForm: byId('join-form'), createButton: byId('create-button'),
    joinButton: byId('join-button'), name: byId('display-name'), title: byId('video-name'),
    mediaType: byId('media-type'), tmdbId: byId('tmdb-id'), episodeFields: byId('episode-fields'),
    season: byId('season'), episode: byId('episode'), rights: byId('rights'), code: byId('invite-code'),
    error: byId('form-message'), screen: byId('screen'), empty: byId('screen-empty'),
    player: byId('party-player'), videoTitle: byId('video-title'), videoSubtitle: byId('video-subtitle'),
    notice: byId('player-notice'), resync: byId('resync-button'), back: byId('back-to-viewing'),
    roomTitle: byId('room-title'), role: byId('room-role'), connection: byId('connection-text'),
    connectionDot: byId('connection-dot'), roomCode: byId('room-code'), copy: byId('copy-invite'),
    count: byId('member-count'), members: byId('members'), messages: byId('messages'),
    chatForm: byId('chat-form'), chatInput: byId('chat-input'), leave: byId('leave-button'), end: byId('end-button')
  };
  const state = {
    client: null, channel: null, retiredChannels: new Set(), channelCleanup: Promise.resolve(true), channelAttempt: 0,
    code: '', name: '', snapshot: null, isHost: false, generation: 0,
    busy: false, refreshing: false, refreshAgain: false, serverOffset: 0, lastSnapshotAt: 0,
    pollTimer: null, heartbeatTimer: null, playerTimer: null, retryTimer: null, retryDelay: 2000,
    realtime: false, awaitingFreshState: false, player: null, blocked: false, episodeChanged: false,
    exiting: false, resyncing: false, initialApplied: false, lastSeek: 0, lastPlayCommand: 0, playAttempts: 0, lastHostSync: 0,
    hostQueue: Promise.resolve(), lastMessageKey: null
  };

  function sessionGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (error) { return ''; } }
  function sessionSet(key, value) { try { sessionStorage.setItem(key, value); return true; } catch (error) { return false; } }
  function sessionRemove(key) { try { sessionStorage.removeItem(key); } catch (error) { /* optional */ } }
  function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (error) { return ''; } }
  function saveName(name) { try { localStorage.setItem(NAME_KEY, name); } catch (error) { /* optional */ } }
  function readActive() {
    try {
      const active = JSON.parse(sessionGet(ACTIVE_KEY));
      return active && playerApi.normalizeCode(active.code) && typeof active.name === 'string' ? active : null;
    } catch (error) { return null; }
  }
  function message(text, kind) {
    ui.error.textContent = String(text || '');
    ui.error.hidden = !text;
    ui.error.dataset.kind = kind || 'error';
  }
  function readableError(error) {
    const value = String(error && error.message || error || '');
    if (/anonymous.*(disabled|not enabled)|signups not allowed/i.test(value)) return 'Anonymous sign-in is not available for the ZEUS party service.';
    if (/failed to fetch|fetch|network|connection|timeout/i.test(value)) return 'Could not reach the party service. Check the connection and try again.';
    if (/party not found|has ended|access denied/i.test(value)) return 'Party not found, has ended, or access was denied.';
    if (/function.*not found|schema cache|zeus_party_/i.test(value)) return 'The existing ZEUS party service is unavailable or not fully configured.';
    return value ? value.slice(0, 200) : 'Something went wrong. Please try again.';
  }
  function setBusy(busy, label) {
    state.busy = busy;
    ui.createButton.disabled = busy;
    ui.joinButton.disabled = busy;
    ui.createButton.firstElementChild.textContent = busy && label ? label : 'Start a party';
    ui.joinButton.firstElementChild.textContent = busy && label ? label : 'Join the party';
  }
  function connection(text, kind) {
    ui.connection.textContent = text;
    ui.connectionDot.dataset.state = kind || 'retry';
  }
  function tab(which) {
    const join = which === 'join';
    ui.createTab.setAttribute('aria-selected', String(!join));
    ui.joinTab.setAttribute('aria-selected', String(join));
    ui.createForm.hidden = join;
    ui.joinForm.hidden = !join;
    message('');
  }
  function setAddress(code) {
    try {
      const url = new URL(location.href);
      // Legacy query-string invites are accepted, but stop retaining the
      // bearer code in subsequent requests and browser history entries.
      url.searchParams.delete('party');
      url.hash = code ? 'party=' + code : '';
      history.replaceState(null, '', url.href);
    } catch (error) { /* an invite still works without rewriting the address */ }
  }
  function validatedName() {
    const name = ui.name.value.trim().slice(0, 32);
    if (!name) { message('Enter your name first.'); ui.name.focus(); return ''; }
    saveName(name);
    return name;
  }
  function setBackLink(room) {
    if (!room || !playerApi.validRoom(room)) return;
    const url = new URL('watch.html', location.href);
    url.searchParams.set('id', String(room.tmdb_id));
    url.searchParams.set('type', room.media_type);
    if (room.media_type === 'tv') {
      url.searchParams.set('season', String(Number(room.season)));
      url.searchParams.set('episode', String(Number(room.episode)));
    }
    ui.back.href = url.href;
    ui.back.firstChild.textContent = 'Back to normal viewing ';
  }
  function updateEpisodeFields() { ui.episodeFields.hidden = ui.mediaType.value !== 'tv'; }
  function mediaFromForm() {
    const title = ui.title.value.trim().slice(0, 200);
    const id = ui.tmdbId.value.trim();
    const type = ui.mediaType.value;
    const season = type === 'tv' ? Number(ui.season.value) : 1;
    const episode = type === 'tv' ? Number(ui.episode.value) : 1;
    const room = { provider: 'cinesrc', media_type: type, tmdb_id: id, season, episode };
    if (!title) throw new Error('Enter a title for the party.');
    if (!playerApi.validRoom(room)) throw new Error('Enter a valid TMDB ID and, for TV, season and episode.');
    if (!ui.rights.checked) throw new Error('Confirm that you are authorized to watch and share this title.');
    return { p_name: '', p_provider: 'cinesrc', p_media_type: type, p_tmdb_id: id,
      p_season: season, p_episode: episode, p_title: title };
  }

  async function getClient() {
    if (state.client) return state.client;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') throw new Error('The party client could not be loaded.');
    const probe = AUTH_KEY + '_probe';
    if (!sessionSet(probe, '1')) throw new Error('Enable session storage to use Watch Party.');
    sessionRemove(probe);
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
    if (typeof client.auth.onAuthStateChange === 'function') {
      client.auth.onAuthStateChange((_event, next) => {
        if (next && next.access_token) {
          setTimeout(() => Promise.resolve(client.realtime.setAuth(next.access_token)).catch(() => {}), 0);
        }
      });
    }
    state.client = client;
    return client;
  }
  async function rpc(client, name, params) {
    const result = await client.rpc(name, params);
    if (result.error) throw result.error;
    return result.data;
  }
  function recordClock(snapshot, start, finish) {
    const serverTime = snapshot && Date.parse(snapshot.server_now);
    if (Number.isFinite(serverTime)) state.serverOffset = serverTime - (start + finish) / 2;
  }
  async function discardIncompatibleJoin(client, snapshot) {
    // Joining an older room can insert a guest membership before the provider
    // is known. Remove that membership; do not pause a legacy room if this
    // same session is its host.
    if (snapshot && snapshot.room && snapshot.you && snapshot.you !== snapshot.room.host_id &&
        playerApi.normalizeCode(snapshot.room.code)) {
      try { await rpc(client, 'zeus_party_leave', { p_code: snapshot.room.code }); } catch (error) { /* expires with the room */ }
    }
  }
  async function createRoom(event) {
    event.preventDefault();
    if (state.busy || state.code) return;
    const name = validatedName();
    if (!name) return;
    let details;
    try { details = mediaFromForm(); } catch (error) { message(readableError(error)); return; }
    details.p_name = name;
    message(''); setBusy(true, 'Creating…');
    try {
      const client = await getClient();
      const start = Date.now();
      const snapshot = await rpc(client, 'zeus_party_create', details);
      const finish = Date.now();
      if (!snapshot || !playerApi.normalizeCode(snapshot.room && snapshot.room.code) || !playerApi.validRoom(snapshot.room)) {
        throw new Error('The party service returned an incompatible room. No other player was loaded.');
      }
      recordClock(snapshot, start, finish);
      enterRoom(snapshot, name, finish);
    } catch (error) { message(readableError(error)); }
    finally { setBusy(false); }
  }
  async function joinRoom(event, automatic) {
    if (event) event.preventDefault();
    if (state.busy || state.code) return;
    const name = validatedName();
    if (!name) return;
    const code = playerApi.codeFrom(ui.code.value, location.href);
    if (!code) { message('Enter a valid party code or invite link.'); ui.code.focus(); return; }
    message(''); setBusy(true, 'Connecting…');
    try {
      const client = await getClient();
      const start = Date.now();
      const snapshot = await rpc(client, 'zeus_party_join', { p_code: code, p_name: name });
      const finish = Date.now();
      if (!snapshot || !snapshot.room || snapshot.room.code !== code || !playerApi.validRoom(snapshot.room)) {
        await discardIncompatibleJoin(client, snapshot);
        throw new Error('This invite is not a CineSrc party. No other player was loaded.');
      }
      recordClock(snapshot, start, finish);
      enterRoom(snapshot, name, finish);
      if (automatic) ui.notice.textContent = 'Rejoined with the same session. Waiting for CineSrc and the latest room state.';
    } catch (error) { message(readableError(error)); }
    finally { setBusy(false); }
  }

  function enterRoom(snapshot, name, receivedAt) {
    state.generation += 1;
    state.code = snapshot.room.code;
    state.name = name;
    state.snapshot = null;
    state.isHost = false;
    state.retryDelay = 2000;
    state.awaitingFreshState = false;
    state.blocked = false;
    state.exiting = false;
    state.resyncing = false;
    state.lastMessageKey = null;
    state.lastSnapshotAt = receivedAt;
    sessionSet(ACTIVE_KEY, JSON.stringify({ code: state.code, name }));
    setAddress(state.code);
    ui.lobby.hidden = true;
    ui.room.hidden = false;
    ui.resync.hidden = false;
    connection('Connecting to the room…', 'retry');
    renderSnapshot(snapshot, receivedAt);
    if (!state.code) return;
    subscribe();
    heartbeat();
    startTimers();
  }
  function startTimers() {
    clearInterval(state.pollTimer); clearInterval(state.heartbeatTimer); clearInterval(state.playerTimer);
    state.pollTimer = setInterval(refresh, POLL_MS);
    state.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    state.playerTimer = setInterval(checkPlayer, PLAYER_POLL_MS);
  }

  function renderMembers(members) {
    ui.members.replaceChildren();
    const list = Array.isArray(members) ? members : [];
    ui.count.textContent = String(list.filter(member => member.online).length);
    list.forEach(member => {
      const item = document.createElement('li');
      item.className = 'member' + (member.online ? '' : ' offline');
      const avatar = document.createElement('span'); avatar.className = 'member-avatar';
      avatar.textContent = String(member.name || '?').trim().slice(0, 1).toUpperCase() || '?';
      const name = document.createElement('span'); name.className = 'member-name';
      name.textContent = String(member.name || 'Guest') + (state.snapshot && member.id === state.snapshot.you ? ' (you)' : '');
      item.append(avatar, name);
      if (member.host) {
        const role = document.createElement('span'); role.className = 'member-role';
        role.textContent = member.online ? 'HOST' : 'HOST · AWAY';
        item.appendChild(role);
      }
      ui.members.appendChild(item);
    });
  }
  function renderMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const key = list.map(entry => entry.id).join(',');
    if (key === state.lastMessageKey) return;
    state.lastMessageKey = key;
    const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 45;
    ui.messages.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('p'); empty.className = 'empty-chat';
      empty.textContent = 'It’s quiet in here. Start the conversation.';
      ui.messages.appendChild(empty);
      return;
    }
    list.forEach(entry => {
      const item = document.createElement('div'); item.className = 'message';
      const name = document.createElement('strong'); name.textContent = String(entry.name || 'Guest');
      const body = document.createElement('span'); body.textContent = String(entry.body || '');
      item.append(name, body); ui.messages.appendChild(item);
    });
    if (nearBottom) ui.messages.scrollTop = ui.messages.scrollHeight;
  }
  function hostOnline() {
    return !!state.snapshot && Array.isArray(state.snapshot.members) &&
      state.snapshot.members.some(member => member.host && member.online);
  }
  function renderSnapshot(snapshot, receivedAt) {
    if (!snapshot || !snapshot.room || !state.code || snapshot.room.code !== state.code) return;
    if (state.snapshot && Number(snapshot.room.revision) < Number(state.snapshot.room.revision)) return;
    state.lastSnapshotAt = receivedAt;
    state.snapshot = snapshot;
    state.isHost = snapshot.you === snapshot.room.host_id;
    if (snapshot.room.ended) {
      resetRoom(); message('This party has ended or expired.', 'info'); return;
    }
    ui.roomTitle.textContent = String(snapshot.room.title || 'Watch party');
    ui.videoTitle.textContent = String(snapshot.room.title || 'Party video');
    ui.videoSubtitle.textContent = state.isHost ? 'You control playback for the room' : 'Following the host’s playback';
    ui.role.textContent = state.isHost ? 'YOU ARE HOST' : 'GUEST';
    ui.roomCode.textContent = playerApi.formatCode(state.code);
    ui.end.hidden = !state.isHost;
    renderMembers(snapshot.members);
    renderMessages(snapshot.messages);
    if (!playerApi.validRoom(snapshot.room)) {
      state.blocked = true;
      destroyPlayer();
      ui.resync.disabled = true;
      ui.notice.textContent = 'This room is not using CineSrc. Playback stopped; leave the party. No other player will be loaded.';
      return;
    }
    setBackLink(snapshot.room);
    ui.resync.disabled = false;
    if (state.blocked || !state.player) {
      state.blocked = false;
      loadPlayer(snapshot.room);
    } else if (!state.isHost) followHost(false);
  }

  function retireChannel(channel) {
    if (channel) state.retiredChannels.add(channel);
  }
  function cleanRetiredChannels() {
    const client = state.client;
    // Supabase may reuse an existing channel for the same topic. Await the
    // public removal operation before creating another, including across a
    // quick leave/rejoin, and serialize overlapping reconnect attempts.
    state.channelCleanup = state.channelCleanup.catch(() => false).then(async () => {
      if (!client) return false;
      for (const channel of Array.from(state.retiredChannels)) {
        let result;
        try { result = await client.removeChannel(channel); } catch (error) { return false; }
        const stillPresent = typeof client.getChannels === 'function'
          ? client.getChannels().includes(channel) : result === 'error' || result === 'timed out';
        if (stillPresent) return false;
        state.retiredChannels.delete(channel);
      }
      return true;
    }).catch(() => false);
    return state.channelCleanup;
  }
  async function subscribe() {
    if (!state.code || !state.client) return;
    const generation = state.generation, code = state.code, client = state.client;
    const attempt = ++state.channelAttempt;
    retireChannel(state.channel);
    state.channel = null;
    state.realtime = false;
    const removed = await cleanRetiredChannels();
    if (state.generation !== generation || state.code !== code || state.channelAttempt !== attempt) return;
    if (!removed) {
      connection('Realtime reconnecting · checking periodically', 'retry');
      scheduleRetry();
      return;
    }
    let channel;
    try {
      channel = client.channel('zeus-party:' + code, { config: { private: true } });
      state.channel = channel;
      channel.on('broadcast', { event: 'changed' }, () => {
        // A broadcast is only a wakeup; authenticated RPC state is authoritative.
        if (state.channel === channel && state.generation === generation && state.channelAttempt === attempt) refresh();
      }).subscribe(status => {
        if (state.channel !== channel || state.generation !== generation || state.code !== code || state.channelAttempt !== attempt) return;
        if (status === 'SUBSCRIBED') {
          state.realtime = true;
          state.retryDelay = 2000;
          clearTimeout(state.retryTimer); state.retryTimer = null;
          connection('Connected · checking room state', 'ready');
          refresh();
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          state.realtime = false;
          connection('Realtime reconnecting · checking periodically', 'retry');
          scheduleRetry();
        }
      });
    } catch (error) {
      if (state.channel === channel) state.channel = null;
      retireChannel(channel);
      connection('Realtime reconnecting · checking periodically', 'retry');
      scheduleRetry();
    }
  }
  function scheduleRetry() {
    if (!state.code || state.retryTimer) return;
    const generation = state.generation;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (state.code && state.generation === generation) subscribe();
    }, state.retryDelay);
    state.retryDelay = Math.min(30000, Math.round(state.retryDelay * 1.7));
  }
  function pauseForReconnect() {
    if (!state.code) return;
    state.awaitingFreshState = true;
    connection('Connection interrupted · retrying', 'retry');
    if (state.player && ui.player && !state.blocked) {
      state.player.suppressedUntil = Date.now() + 1500;
      playerApi.send(ui.player, 'pause');
    }
    ui.notice.textContent = 'Trying to pause until the room reconnects. If it keeps playing, pause it in CineSrc.';
  }
  async function refresh() {
    if (!state.code || !state.client) return;
    if (state.refreshing) { state.refreshAgain = true; return; }
    state.refreshing = true;
    const code = state.code, generation = state.generation;
    try {
      let start = Date.now();
      let snapshot;
      try {
        snapshot = await rpc(state.client, 'zeus_party_snapshot', { p_code: code });
      } catch (error) {
        if (error && error.code !== '42501' && !/access denied/i.test(String(error.message || ''))) throw error;
        // The same authenticated session can rejoin after a membership prune.
        // The host UUID is unchanged; another participant is never promoted.
        start = Date.now();
        snapshot = await rpc(state.client, 'zeus_party_join', { p_code: code, p_name: state.name });
      }
      if (state.code !== code || state.generation !== generation || !navigator.onLine) return;
      const finish = Date.now();
      const wasReconnecting = state.awaitingFreshState;
      state.awaitingFreshState = false;
      recordClock(snapshot, start, finish);
      renderSnapshot(snapshot, finish);
      if (state.code !== code) return;
      if (wasReconnecting && state.isHost && state.player && !state.blocked) {
        // Do not resume a host from stale state after a disconnect. Pause the
        // current player and publish that pause; the host can press play again.
        state.player.suppressedUntil = Date.now() + 1500;
        playerApi.send(ui.player, 'pause');
        const position = state.player.time ?? playerApi.targetTime(state.snapshot.room, state.serverOffset);
        queueHost('pause', position);
      } else if (wasReconnecting && !state.isHost) followHost(true);
      if (!state.realtime) connection('Checking room · Realtime reconnecting', 'retry');
      else connection('Connected · checking room state', 'ready');
    } catch (error) {
      if (state.code === code && state.generation === generation) {
        pauseForReconnect();
        if (/party not found|has ended/i.test(String(error && error.message || error))) {
          resetRoom(); message('This party has ended or expired.', 'info');
        }
      }
    } finally {
      // A request from a previous room or cached page must not unlock a newer
      // refresh that is still in flight.
      if (state.code === code && state.generation === generation) {
        state.refreshing = false;
        if (state.refreshAgain) { state.refreshAgain = false; refresh(); }
      }
    }
  }
  async function heartbeat() {
    if (!state.code || !state.client) return;
    const code = state.code, generation = state.generation;
    try { await rpc(state.client, 'zeus_party_heartbeat', { p_code: code }); }
    catch (error) {
      if (state.code === code && state.generation === generation) { pauseForReconnect(); refresh(); }
    }
  }

  function destroyPlayer() {
    // Removing the browsing context, rather than merely hiding it, stops any
    // previous player's audio. A replacement is created only after removal.
    if (ui.player) {
      if (state.player) playerApi.send(ui.player, 'pause');
      ui.player.src = 'about:blank';
      ui.player.remove();
      ui.player = null;
    }
    state.player = null;
    state.initialApplied = false;
    ui.empty.hidden = false;
  }
  function loadPlayer(room) {
    if (!state.code || !playerApi.validRoom(room)) return;
    let src;
    try { src = playerApi.buildUrl(room, playerApi.targetTime(room, state.serverOffset)); }
    catch (error) { ui.notice.textContent = 'This CineSrc player could not be loaded.'; return; }
    destroyPlayer();
    const frame = document.createElement('iframe');
    frame.id = 'party-player';
    frame.title = 'CineSrc party player';
    frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    ui.player = frame;
    state.player = { time: null, paused: null, lastTimeAt: 0, lastEventAt: 0,
      startedAt: Date.now(), suppressedUntil: 0, episodePauseAt: 0, errorNotice: '' };
    state.episodeChanged = false;
    state.initialApplied = false;
    state.lastSeek = state.lastPlayCommand = state.playAttempts = state.lastHostSync = 0;
    ui.empty.hidden = true;
    ui.screen.appendChild(frame);
    frame.src = src;
    ui.notice.textContent = 'Waiting for CineSrc. If playback is blocked, click inside the player and use Resync.';
  }
  function followHost(force) {
    if (!state.code || !state.snapshot || !state.player || state.isHost || state.blocked || state.episodeChanged ||
        !state.initialApplied || state.awaitingFreshState || !navigator.onLine) return;
    const now = Date.now();
    if (!hostOnline()) {
      if (state.player.paused !== true && now - state.lastPlayCommand > 2800) {
        playerApi.send(ui.player, 'pause'); state.lastPlayCommand = now;
      }
      ui.notice.textContent = 'The host is away. Playback waits for the same host to return.';
      return;
    }
    const room = state.snapshot.room;
    const target = playerApi.targetTime(room, state.serverOffset, now);
    const local = state.player.time === null ? null : state.player.time +
      (state.player.paused === false ? Math.min(4, Math.max(0, (now - state.player.lastTimeAt) / 1000)) : 0);
    const drift = local === null ? Infinity : Math.abs(local - target);
    if ((force || drift > DRIFT_SECONDS) && now - state.lastSeek > 2500) {
      playerApi.send(ui.player, 'seek', target); state.lastSeek = now;
    }
    const needsAction = state.player.paused === null || state.player.paused === room.playing;
    if ((force || needsAction) && now - state.lastPlayCommand > 2800) {
      playerApi.send(ui.player, room.playing ? 'play' : 'pause');
      state.lastPlayCommand = now;
      if (room.playing && needsAction) state.playAttempts += 1;
    }
    if (state.player.errorNotice) ui.notice.textContent = state.player.errorNotice;
    else if (room.playing && state.playAttempts >= 3 && state.player.paused !== false) {
      ui.notice.textContent = 'Playback may be blocked. Click inside CineSrc, then use Resync.';
    } else if (state.player.lastEventAt) {
      ui.notice.textContent = 'Following the host when the player allows it. Use Resync if timing drifts.';
    }
  }
  function queueHost(action, time) {
    if (!state.code || !state.isHost || !state.client || !state.player || state.blocked || state.awaitingFreshState ||
        state.exiting || state.resyncing) return;
    const position = playerApi.finiteTime(time);
    if (position === null) return;
    const code = state.code, generation = state.generation, player = state.player;
    state.lastHostSync = Date.now();
    state.hostQueue = state.hostQueue.catch(() => {}).then(async () => {
      if (state.code !== code || state.generation !== generation || !state.isHost || state.player !== player ||
          state.blocked || state.awaitingFreshState || !playerApi.validRoom(state.snapshot && state.snapshot.room)) return;
      await rpc(state.client, 'zeus_party_playback', { p_code: code, p_action: action, p_time: position });
      if (state.code === code && state.generation === generation) refresh();
    }).catch(() => {
      if (state.code === code && state.generation === generation && state.player === player) {
        pauseForReconnect();
        ui.notice.textContent = 'Could not share playback. Waiting for the room to reconnect.';
        refresh();
      }
    });
  }
  function pauseChangedEpisode(force) {
    if (!state.player || !ui.player) return;
    const now = Date.now();
    if (force || now - state.player.episodePauseAt > 1500) {
      state.player.episodePauseAt = now;
      playerApi.send(ui.player, 'pause');
    }
  }
  function onPlayerMessage(event) {
    if (!state.code || !state.player || !state.snapshot || state.blocked || !ui.player || state.exiting || state.resyncing) return;
    const received = playerApi.readEvent(event, ui.player);
    if (!received) return;
    const player = state.player;
    const now = Date.now();
    if (received.kind === 'nextepisode') {
      state.episodeChanged = true;
      player.suppressedUntil = now + 1500;
      pauseChangedEpisode(true);
      if (state.isHost) queueHost('pause', player.time ?? playerApi.targetTime(state.snapshot.room, state.serverOffset, now));
      ui.notice.textContent = 'CineSrc changed episodes locally. Use Resync to return to the room’s episode; pause in CineSrc if it keeps playing.';
      return;
    }
    if (state.episodeChanged) {
      // CineSrc may navigate internally after emitting nextepisode. A pause sent
      // to the previous document is not enough; pause the newly ready/playing
      // document too, without replacing the iframe during internal navigation.
      if (received.paused !== null) player.paused = received.paused;
      if (received.kind === 'ready') player.paused = null;
      if (received.kind === 'ready' || received.kind === 'play' || received.paused === false) pauseChangedEpisode(true);
      return;
    }
    if (received.kind === 'error') {
      const detail = String(received.error || 'Player error').replace(/https?:\/\/\S+/gi, '[link omitted]')
        .replace(/\s+/g, ' ').trim().slice(0, 140);
      player.errorNotice = 'CineSrc: ' + detail + '. Use Resync to retry. ZEUS will not switch players.';
      ui.notice.textContent = player.errorNotice;
      return;
    }
    if (received.kind === 'ready') {
      playerApi.send(ui.player, 'status');
      return; // Ready alone is not proof that a source is playable.
    }
    if (player.errorNotice && (received.kind === 'play' || (received.kind === 'timeupdate' && received.time !== null && received.time > 0))) {
      player.errorNotice = '';
    }
    if (received.time !== null || received.paused !== null) player.lastEventAt = now;
    if (received.time !== null) { player.time = received.time; player.lastTimeAt = now; }
    if (received.paused !== null) player.paused = received.paused;
    if (state.awaitingFreshState) return;
    if (!state.initialApplied && (received.time !== null || received.paused !== null)) {
      state.initialApplied = true;
      const room = state.snapshot.room;
      const target = playerApi.targetTime(room, state.serverOffset, now);
      if (state.isHost) {
        player.suppressedUntil = now + 1200;
        // The getter may describe the player before the initial seek.
        player.time = null; player.lastTimeAt = 0;
        playerApi.send(ui.player, 'seek', target);
        if (received.kind === 'play' && !room.playing) {
          // A host may click play before the first getter response arrives.
          player.suppressedUntil = 0;
          queueHost('play', target);
        } else playerApi.send(ui.player, room.playing ? 'play' : 'pause');
        if (!player.errorNotice) ui.notice.textContent = 'You control playback for the room. Click inside CineSrc to start.';
      } else followHost(true);
      return;
    }
    if (state.isHost) {
      const action = received.kind === 'ended' ? 'pause' : received.kind;
      if (now < player.suppressedUntil) {
        const room = state.snapshot.room;
        const target = playerApi.targetTime(room, state.serverOffset, now);
        const echo = (action === 'play' && room.playing) || (action === 'pause' && !room.playing) ||
          (action === 'seeked' && player.time !== null && Math.abs(player.time - target) < DRIFT_SECONDS);
        if (echo) return;
        if (['play', 'pause', 'seeked'].includes(action)) player.suppressedUntil = 0;
      }
      if (['play', 'pause', 'seeked'].includes(action)) {
        if (action === 'seeked' && received.time === null) return;
        // CineSrc's play/pause events have no position. Use a recent getter or
        // the room clock rather than resetting a resumed room to zero.
        const recent = player.time !== null && now - player.lastTimeAt < 5000 ? player.time : null;
        const position = received.time ?? recent ?? playerApi.targetTime(state.snapshot.room, state.serverOffset, now);
        queueHost(action === 'seeked' ? 'seek' : action, position);
      }
    } else if (state.initialApplied) {
      if (player.paused === false) state.playAttempts = 0;
      followHost(false);
    }
  }
  function checkPlayer() {
    if (!state.code || !state.snapshot || !state.player || state.blocked || state.exiting || state.resyncing) return;
    const now = Date.now();
    if (!navigator.onLine || (state.lastSnapshotAt && now - state.lastSnapshotAt > 20000)) {
      if (!state.awaitingFreshState) pauseForReconnect();
      return;
    }
    if (state.awaitingFreshState) return;
    if (state.episodeChanged) {
      if (state.player.paused !== true) pauseChangedEpisode(false);
      playerApi.send(ui.player, 'status');
      return;
    }
    playerApi.send(ui.player, 'status');
    if (state.isHost && state.initialApplied && state.player.time !== null && now - state.player.lastTimeAt < 5000 &&
        now - state.lastHostSync > HOST_SYNC_MS && now > state.player.suppressedUntil) {
      if (state.player.paused === false) queueHost('sync_play', state.player.time);
      // A getter can repair a missed pause event; otherwise a stale playing
      // room could continue indefinitely while the host is actually paused.
      else if (state.player.paused === true && state.snapshot.room.playing) queueHost('sync_pause', state.player.time);
    }
    if (!state.isHost && state.initialApplied) followHost(false);
    if (!state.player.errorNotice && !state.player.lastEventAt && now - state.player.startedAt > 14000) {
      ui.notice.textContent = 'CineSrc has not sent playback events. Click inside the player or use Resync; no other player will be loaded.';
    }
  }

  async function resyncPlayer() {
    if (!state.code || !state.snapshot || state.blocked || state.resyncing || state.exiting) return;
    if (state.awaitingFreshState || !navigator.onLine) { refresh(); return; }
    const code = state.code, generation = state.generation, player = state.player;
    const stale = player && (!player.lastEventAt || Date.now() - player.lastEventAt > 10000);
    const reload = !player || state.episodeChanged || !state.initialApplied || player.errorNotice || stale;
    if (!reload) {
      if (state.isHost) {
        const position = player.time !== null && Date.now() - player.lastTimeAt < 5000 ? player.time
          : playerApi.targetTime(state.snapshot.room, state.serverOffset);
        if (player.paused !== null) queueHost(player.paused ? 'sync_pause' : 'sync_play', position);
        ui.notice.textContent = 'Sharing the host’s current playback state with the room.';
      } else {
        state.lastSeek = 0; state.lastPlayCommand = 0; state.playAttempts = 0;
        followHost(true);
      }
      refresh();
      return;
    }

    // A retry replaces the iframe. Serialize a host pause behind earlier host
    // actions and read the committed room before destroying the old player;
    // otherwise a late play RPC could make guests play while the new host
    // player is paused. A healthy host player does not need to be reloaded.
    if (state.isHost && player) {
      const position = player.time !== null && (state.episodeChanged || Date.now() - player.lastTimeAt < 5000)
        ? player.time : playerApi.targetTime(state.snapshot.room, state.serverOffset);
      queueHost('pause', position);
    }
    state.resyncing = true;
    ui.resync.disabled = true;
    if (ui.player) {
      ui.player.setAttribute('inert', '');
      playerApi.send(ui.player, 'pause');
    }
    ui.notice.textContent = 'Retrying CineSrc. The host can press play when the room is ready.';
    try {
      if (state.isHost) {
        await state.hostQueue;
        if (state.code !== code || state.generation !== generation || state.exiting || state.awaitingFreshState || !navigator.onLine) return;
        const start = Date.now();
        const snapshot = await rpc(state.client, 'zeus_party_snapshot', { p_code: code });
        const finish = Date.now();
        if (state.code !== code || state.generation !== generation || state.exiting || !navigator.onLine) return;
        recordClock(snapshot, start, finish);
        renderSnapshot(snapshot, finish);
      }
      if (state.code !== code || state.generation !== generation || state.exiting || state.blocked || state.awaitingFreshState) return;
      loadPlayer(state.snapshot.room);
      if (state.isHost) ui.notice.textContent = 'CineSrc restarted. Press play when you are ready.';
      refresh();
    } catch (error) {
      if (state.code === code && state.generation === generation) { pauseForReconnect(); refresh(); }
    } finally {
      if (state.code === code && state.generation === generation) {
        state.resyncing = false;
        ui.resync.disabled = state.blocked || state.exiting;
        if (ui.player) ui.player.removeAttribute('inert');
      }
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const body = ui.chatInput.value.trim();
    if (!body || !state.code || !state.client) return;
    ui.chatInput.disabled = true;
    try {
      await rpc(state.client, 'zeus_party_chat', { p_code: state.code, p_body: body });
      ui.chatInput.value = '';
      await refresh();
      ui.messages.scrollTop = ui.messages.scrollHeight;
    } catch (error) { message(readableError(error)); }
    finally { ui.chatInput.disabled = false; ui.chatInput.focus(); }
  }
  async function copyInvite() {
    const invite = playerApi.inviteUrl(location.href, state.code);
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite);
      message('Invite link copied. Share it only with people you trust.', 'info');
    } catch (error) {
      const input = document.createElement('textarea'); input.value = invite;
      input.setAttribute('readonly', ''); input.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(input); input.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (ignored) { /* unavailable */ }
      input.remove();
      message(copied ? 'Invite link copied. Share it only with people you trust.' : 'Copy the party code above to invite someone.', 'info');
    }
  }
  function resetRoom() {
    state.generation += 1;
    clearInterval(state.pollTimer); clearInterval(state.heartbeatTimer); clearInterval(state.playerTimer); clearTimeout(state.retryTimer);
    state.pollTimer = state.heartbeatTimer = state.playerTimer = state.retryTimer = null;
    state.channelAttempt += 1;
    retireChannel(state.channel); state.channel = null;
    cleanRetiredChannels();
    destroyPlayer();
    state.code = ''; state.name = ''; state.snapshot = null; state.isHost = false; state.realtime = false;
    state.refreshing = false; state.refreshAgain = false; state.awaitingFreshState = false; state.blocked = false;
    state.episodeChanged = false; state.exiting = false; state.resyncing = false; state.hostQueue = Promise.resolve();
    state.lastSnapshotAt = 0; state.lastMessageKey = null;
    ui.resync.hidden = true; ui.resync.disabled = false;
    ui.videoTitle.textContent = 'Nothing playing yet'; ui.videoSubtitle.textContent = 'CineSrc opens after you create or join';
    ui.notice.textContent = 'Only the host changes the room’s playback. Autoplay and timing depend on each browser and stream.';
    ui.room.hidden = true; ui.lobby.hidden = false;
    sessionRemove(ACTIVE_KEY); setAddress('');
  }
  async function leaveRoom(end) {
    if (!state.code || !state.client || state.exiting) return;
    if (end && !window.confirm('End this party for everyone?')) return;
    const code = state.code, generation = state.generation, wasHost = state.isHost;
    state.exiting = true;
    ui.leave.disabled = true; ui.end.disabled = true; ui.resync.disabled = true;
    if (state.player && ui.player) playerApi.send(ui.player, 'pause');
    try {
      // Finish already queued host updates before the server-side leave/end.
      // New player events are ignored while exiting, so a late play cannot
      // overwrite the pause performed by zeus_party_leave.
      if (wasHost) await state.hostQueue;
      if (state.code !== code || state.generation !== generation) return;
      await rpc(state.client, end ? 'zeus_party_end' : 'zeus_party_leave', { p_code: code });
      if (state.code === code && state.generation === generation) {
        resetRoom(); message(end ? 'The party has ended.' : 'You left the party.', 'info');
      }
    } catch (error) {
      if (state.code !== code || state.generation !== generation) return;
      if (!end) { resetRoom(); message('Left on this device. The room may take a moment to show you as away.', 'info'); }
      else {
        state.exiting = false;
        pauseForReconnect(); refresh();
        message('Could not end the room. Reconnect and try again.');
      }
    } finally {
      if (!state.code || (state.code === code && state.generation === generation)) {
        state.exiting = false; ui.leave.disabled = false; ui.end.disabled = false;
        ui.resync.disabled = state.blocked;
      }
    }
  }

  ui.createTab.addEventListener('click', () => tab('create'));
  ui.joinTab.addEventListener('click', () => tab('join'));
  [ui.createTab, ui.joinTab].forEach(button => button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = button === ui.createTab ? ui.joinTab : ui.createTab;
    tab(next === ui.joinTab ? 'join' : 'create'); next.focus();
  }));
  ui.mediaType.addEventListener('change', updateEpisodeFields);
  ui.createForm.addEventListener('submit', createRoom);
  ui.joinForm.addEventListener('submit', event => joinRoom(event, false));
  ui.chatForm.addEventListener('submit', sendChat);
  ui.copy.addEventListener('click', copyInvite);
  ui.leave.addEventListener('click', () => leaveRoom(false));
  ui.end.addEventListener('click', () => leaveRoom(true));
  ui.resync.addEventListener('click', resyncPlayer);
  window.addEventListener('message', onPlayerMessage);
  window.addEventListener('offline', pauseForReconnect);
  window.addEventListener('online', () => {
    if (!state.code) return;
    state.awaitingFreshState = true;
    clearTimeout(state.retryTimer); state.retryTimer = null;
    subscribe(); heartbeat(); refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.code) return;
    if (state.lastSnapshotAt && Date.now() - state.lastSnapshotAt > 20000 && !state.awaitingFreshState) pauseForReconnect();
    heartbeat(); refresh();
  });
  window.addEventListener('pagehide', () => {
    if (!state.code) return;
    // Stop even a page retained in the back/forward cache: a hidden previous
    // iframe must never continue alongside a new normal or party player.
    state.generation += 1;
    state.awaitingFreshState = true;
    state.refreshing = false; state.refreshAgain = false; state.hostQueue = Promise.resolve();
    state.exiting = false; state.resyncing = false; state.realtime = false;
    clearInterval(state.pollTimer); clearInterval(state.heartbeatTimer); clearInterval(state.playerTimer); clearTimeout(state.retryTimer);
    state.pollTimer = state.heartbeatTimer = state.playerTimer = state.retryTimer = null;
    state.channelAttempt += 1;
    retireChannel(state.channel); state.channel = null; cleanRetiredChannels();
    ui.leave.disabled = false; ui.end.disabled = false; ui.resync.disabled = state.blocked;
    destroyPlayer();
    ui.notice.textContent = 'Returning to the room requires a fresh connection and player.';
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !state.code) return;
    state.awaitingFreshState = true;
    subscribe(); heartbeat(); refresh(); startTimers();
  });

  function init() {
    ui.name.value = savedName();
    const params = new URLSearchParams(location.search);
    const id = params.get('id') || '';
    const type = params.get('type') || 'movie';
    if (/^[0-9]{1,12}$/.test(id) && ['movie', 'tv'].includes(type)) {
      ui.tmdbId.value = id;
      ui.mediaType.value = type;
      ui.title.value = String(params.get('title') || ((type === 'tv' ? 'Series #' : 'Movie #') + id)).slice(0, 200);
      const season = Number(params.get('season'));
      const episode = Number(params.get('episode'));
      if (Number.isInteger(season) && season >= 1 && season <= 999) ui.season.value = String(season);
      if (Number.isInteger(episode) && episode >= 1 && episode <= 9999) ui.episode.value = String(episode);
      setBackLink({ provider: 'cinesrc', media_type: type, tmdb_id: id, season: Number(ui.season.value), episode: Number(ui.episode.value) });
    }
    updateEpisodeFields();
    const invite = playerApi.codeFrom(location.href, location.href);
    const active = readActive();
    if (invite) { setAddress(invite); ui.code.value = playerApi.formatCode(invite); tab('join'); }
    if (invite && active && invite === active.code) {
      ui.name.value = active.name;
      joinRoom(null, true);
    }
  }
  init();
})();
