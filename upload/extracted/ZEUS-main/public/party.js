/* ============================================================
   ZEUS — party.js
   Client for the ZEUS Watch Party room (party.html), talking to the
   Cloudflare Worker + Durable Object backend (party-worker/).

   - Backend URL is configurable:
       1. localStorage "zeus_party_backend" (Save button on the join
          screen — paste YOUR deployed worker URL once)
       2. DEFAULT_BACKEND below (the zeus-party worker on
          workers.dev — replace YOUR_WORKERS_SUBDOMAIN after
          `wrangler deploy`)
     Works from BOTH Cloudflare Pages and Vercel deployments — no
     localhost is used anywhere.
   - Rooms: no ?room= -> POST {BACKEND}/api/rooms, then the URL is
     rewritten to party.html?room=ID (url/title params preserved for
     the auto "Set Video")
   - WebSocket: {BACKEND}/ws?room=ID&name=ENCODED_NAME  (https -> wss)
   - Message protocol (JSON over the WebSocket):
       -> { type:"join", name }                 (confirm display name)
       -> { type:"set_media", media:{type,url,title} }   (host only)
       -> { type:"play"|"pause"|"seek", time }
       -> { type:"chat", message, ts }
       <- { type:"state", state, you, serverNow }  (join + every update)
       <- { type:"members", members } / { type:"host", hostId }
       <- { type:"chat", name, message, ts }   / { type:"error", message }
   - Synced playback for YouTube (IFrame API) and direct MP4
   - Live chat + member list + invite link
   - Host rules: the host drives playback (play/pause/seek) and is the
     only one who can set the room video; non-hosts can still paste a
     URL locally (it does NOT change the room media)
   - Drift correction: non-hosts compare their player time with the
     room target time; a difference > 1.2s triggers a local seek
   - Sources that are neither YouTube nor direct .mp4 can't be synced —
     the room still works (chat + manual link paste)
============================================================ */

'use strict';

(function () {

  /* ================= configuration ================= */

  /* Deploy the worker (cd party-worker && npx wrangler deploy), then
     either replace YOUR_WORKERS_SUBDOMAIN here or just paste the URL
     once into the "Party backend URL" field on the join screen — it is
     saved per browser under the key below. */
  const DEFAULT_BACKEND = 'https://zeus-party.YOUR_WORKERS_SUBDOMAIN.workers.dev';
  const BACKEND_STORAGE_KEY = 'zeus_party_backend';

  function normalizeBackend(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }
  function savedBackend() {
    try { return normalizeBackend(localStorage.getItem(BACKEND_STORAGE_KEY)); } catch (err) { return ''; }
  }
  let BACKEND = savedBackend() || DEFAULT_BACKEND;

  const DRIFT_TOLERANCE = 1.2;   /* seconds — seek when further off   */
  const SYNC_INTERVAL = 1500;    /* ms     — drift check cadence      */
  const PING_INTERVAL = 25000;   /* ms     — websocket keep-alive     */
  const RECONNECT_BASE = 1000;   /* ms     — first reconnect delay    */
  const RECONNECT_MAX = 8000;    /* ms     — reconnect delay cap      */

  /* ================= dom ================= */

  const $ = (id) => document.getElementById(id);
  const els = {
    roomCodeBadge: $('room-code-badge'),
    roomCodeText: $('room-code-text'),
    connPill: $('conn-pill'),
    connLabel: $('conn-label'),
    mediaEyebrow: $('media-eyebrow'),
    mediaTitle: $('media-title'),
    typeBadge: $('type-badge'),
    syncPill: $('sync-pill'),
    syncLabel: $('sync-label'),
    stage: $('player-stage'),
    yt: $('yt-player'),
    mp4: $('mp4-player'),
    stageEmpty: $('stage-empty'),
    stageNotice: $('stage-notice'),
    noticeUrl: $('notice-url'),
    tapOverlay: $('tap-overlay'),
    mediaForm: $('media-form'),
    mediaInput: $('media-url-input'),
    setVideoBtn: $('set-video-btn'),
    hostHint: $('host-hint-text'),
    inviteCode: $('invite-code'),
    inviteLink: $('invite-link'),
    copyInviteBtn: $('copy-invite-btn'),
    membersRow: $('members-row'),
    chatMessages: $('chat-messages'),
    chatEmpty: $('chat-empty'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    joinOverlay: $('join-overlay'),
    nameInput: $('name-input'),
    backendInput: $('backend-input'),
    saveBackendBtn: $('save-backend-btn'),
    joinBtn: $('join-btn'),
    joinError: $('join-error'),
    joinMeta: $('join-meta'),
    toasts: $('toast-container'),
  };

  /* ================= state ================= */

  const qs = new URLSearchParams(location.search);
  const paramRoom = (qs.get('room') || '').trim().toUpperCase();
  const paramUrl = qs.get('url') || '';
  const paramTitle = qs.get('title') || '';

  const state = {
    roomId: paramRoom || null,
    displayName: '',
    ws: null,
    wsOpen: false,
    everConnected: false,   /* at least one successful connection    */
    reconnectAttempts: 0,
    reconnectTimer: null,
    pingTimer: null,
    myId: null,             /* this client's member id (from "you")  */
    hostId: null,
    isHost: false,
    roomMediaUrl: null,     /* media set on the room (host)          */
    currentMedia: null,     /* media loaded locally right now        */
    localOverride: false,   /* non-host watching a local URL         */
    lastState: null,        /* last room snapshot (playback)         */
    clockSkew: 0,           /* serverNow - clientNow, in ms          */
    autoSetDone: false,     /* one-shot auto "Set Video" from ?url=  */
    joined: false,
  };

  /* ================= utilities ================= */

  function toast(message, type) {
    const t = document.createElement('div');
    t.className = 'toast';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.innerHTML = type === 'error'
      ? '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>'
      : '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>';
    const span = document.createElement('span');
    span.textContent = message;
    t.append(icon, span);
    els.toasts.appendChild(t);
    setTimeout(() => t.classList.add('removing'), 2600);
    setTimeout(() => t.remove(), 3100);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) { /* legacy fallback below */ }
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

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function randomGuestName() {
    const tail = Math.random().toString(36).slice(2, 6);
    return 'Guest-' + tail.toUpperCase();
  }

  /* ================= media detection ================= */

  function parseYouTubeId(url) {
    if (typeof url !== 'string') return null;
    const patterns = [
      /youtu\.be\/([\w-]{11})(?:[?&#]|$)/,
      /[?&]v=([\w-]{11})(?:[&]|$)/,
      /youtube\.com\/embed\/([\w-]{11})(?:[?&#]|$)/,
      /youtube\.com\/shorts\/([\w-]{11})(?:[?&#]|$)/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function detectMediaType(url) {
    const u = (url || '').trim();
    if (!u) return 'unknown';
    if (parseYouTubeId(u)) return 'youtube';
    if (/\.mp4([?#]|$)/i.test(u)) return 'mp4';
    return 'unknown';
  }

  function mediaTitleFor(media) {
    if (media.title && media.title.trim()) return media.title.trim();
    if (media.type === 'youtube') return 'YouTube video';
    if (media.type === 'mp4') {
      try { return decodeURIComponent(media.url.split('/').pop().split('?')[0]) || 'MP4 video'; }
      catch (err) { return 'MP4 video'; }
    }
    return 'Custom source';
  }

  /* ================= room / backend plumbing ================= */

  /* https://... -> wss://...   (and http -> ws, ws(s) stays as-is) */
  function wsBase(url) {
    return url.replace(/^http/i, 'ws');
  }
  /* ws://... -> http://...     (for REST calls: /api/rooms, /health) */
  function httpBase(url) {
    return url.replace(/^ws/i, 'http');
  }

  function wsUrl(roomId, name) {
    return wsBase(BACKEND) + '/ws?room=' + encodeURIComponent(roomId) +
           '&name=' + encodeURIComponent(name);
  }

  function wsReady() {
    return !!(state.ws && state.ws.readyState === 1);
  }

  async function createRoom() {
    const res = await fetch(httpBase(BACKEND) + '/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('room create failed (' + res.status + ')');
    const data = await res.json();
    return String(data.roomId);
  }

  function updateUrlWithRoom() {
    try {
      const params = new URLSearchParams();
      params.set('room', state.roomId);
      if (paramUrl) params.set('url', paramUrl);
      if (paramTitle) params.set('title', paramTitle);
      history.replaceState(null, '', location.pathname + '?' + params.toString());
    } catch (err) { /* non-fatal */ }
  }

  function renderRoomBadges() {
    els.roomCodeText.textContent = state.roomId || '------';
    els.inviteCode.textContent = state.roomId || '------';
    els.roomCodeBadge.classList.toggle('is-visible', !!state.roomId);
    if (state.roomId) {
      els.inviteLink.value = location.origin + location.pathname + '?room=' + state.roomId;
    }
  }

  /* ---- websocket connection (with resilient rejoin) ---- */

  function connectSocket() {
    clearTimers();
    setConn('connecting', 'Connecting…');

    let ws;
    try {
      ws = new WebSocket(wsUrl(state.roomId, state.displayName));
    } catch (err) {
      scheduleReconnect();
      return;
    }
    state.ws = ws;
    state.wsOpen = false;

    ws.onopen = () => {
      state.wsOpen = true;
      state.everConnected = true;
      state.reconnectAttempts = 0;
      setConn('connected', 'Connected');
      hideJoinError();
      /* protocol: confirm our display name (the server also got it
         from the ?name= query param on the WS URL) */
      wsSend({ type: 'join', name: state.displayName });
      startPing();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch (err) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      handleMessage(msg);
    };

    ws.onclose = () => {
      state.wsOpen = false;
      stopPing();
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose follows */ };
  }

  function wsSend(obj) {
    if (!wsReady()) return false;
    try { state.ws.send(JSON.stringify(obj)); return true; } catch (err) { return false; }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, state.reconnectAttempts), RECONNECT_MAX);
    state.reconnectAttempts += 1;

    /* Never connected on this join? After a few quick attempts, stop
       and let the user fix the backend URL on the join screen. */
    if (!state.everConnected && state.reconnectAttempts > 2) {
      setConn('error', "Can't reach backend");
      rejoinOverlay(
        "Can't reach the party backend at " + BACKEND + '. ' +
        'Check the URL above (your deployed worker, e.g. https://zeus-party.YOUR_SUBDOMAIN.workers.dev) and press Save, then Join again.'
      );
      return;
    }

    setConn('reconnecting', 'Reconnecting…');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectSocket();
    }, delay);
  }

  function startPing() {
    stopPing();
    state.pingTimer = setInterval(() => {
      wsSend({ type: 'ping' });
    }, PING_INTERVAL);
  }
  function stopPing() {
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
  }
  function clearTimers() {
    stopPing();
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }

  /* Bring the join overlay back (fatal first-join error) so the
     backend URL can be corrected. */
  function rejoinOverlay(message) {
    clearTimers();
    state.joined = false;
    state.ws = null;
    state.wsOpen = false;
    els.joinOverlay.classList.remove('is-hidden');
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = 'Join the Party';
    showJoinError(message);
  }

  function setConn(kind, label) {
    els.connPill.classList.toggle('is-connected', kind === 'connected');
    els.connPill.classList.toggle('is-error', kind === 'error');
    els.connLabel.textContent = label;
  }

  /* ================= server -> client handlers ================= */

  function handleMessage(msg) {
    switch (msg.type) {
      case 'state':   onState(msg); break;
      case 'members': onMembers(msg.members); break;
      case 'host':    onHost(msg.hostId); break;
      case 'chat':    onChat(msg); break;
      case 'error':   toast(msg.message || 'Party error', 'error'); break;
      case 'pong':    break; /* keep-alive reply */
      default:        break;
    }
  }

  function onState(msg) {
    const s = msg.state || {};
    if (msg.you) state.myId = msg.you;
    if (typeof msg.serverNow === 'number') state.clockSkew = msg.serverNow - Date.now();

    state.hostId = s.hostId || null;
    state.isHost = !!(state.myId && state.hostId === state.myId);

    state.lastState = {
      paused: !!s.paused,
      time: Number(s.time) || 0,
      updatedAt: Number(s.updatedAt) || 0,
      receivedAt: performance.now(),
    };

    refreshHostUI();
    if (Array.isArray(s.members)) renderMembers(s.members);
    maybeAutoSetFromUrlParam(s);

    if (s.media && s.media.url) {
      const roomChanged = state.roomMediaUrl !== s.media.url;
      if (roomChanged) {
        state.roomMediaUrl = s.media.url;
        state.localOverride = false;
        applyMedia(s.media, { time: state.lastState.time, paused: state.lastState.paused, force: true });
      } else if (!state.localOverride && !state.isHost) {
        syncPlayback(); /* drift correction */
      }
    } else if (state.roomMediaUrl || state.currentMedia) {
      state.roomMediaUrl = null;
      state.localOverride = false;
      resetStage();
    }
    updateSyncPill();
  }

  function onHost(hostId) {
    const wasHost = state.isHost;
    state.hostId = hostId || null;
    state.isHost = !!(state.myId && state.hostId === state.myId);
    refreshHostUI();
    updateSyncPill();
    if (state.isHost && !wasHost && state.joined) {
      toast("You're now the host — you control playback.");
    }
  }

  function onMembers(members) {
    renderMembers(members || []);
  }

  function onChat(msg) {
    appendChatMessage(msg);
  }

  /* ---- one-shot: auto "Set Video" from ?url= (host only) ---- */

  function maybeAutoSetFromUrlParam(roomSnapshot) {
    if (state.autoSetDone || !paramUrl || !state.isHost) return;
    state.autoSetDone = true;
    if (roomSnapshot && roomSnapshot.media && roomSnapshot.media.url) return; /* room already has a video */
    els.mediaInput.value = paramUrl;
    hostSetVideo(paramUrl, paramTitle);
    toast(detectMediaType(paramUrl) === 'unknown'
      ? "This source can't be synced automatically."
      : 'Video loaded from your watch page.');
  }

  /* ================= player: stage management ================= */

  function resetStage() {
    state.currentMedia = null;
    els.stageEmpty.classList.remove('is-hidden');
    els.stageNotice.classList.remove('is-visible');
    els.yt.classList.remove('is-active');
    els.mp4.classList.remove('is-active');
    els.tapOverlay.classList.remove('is-visible');
    els.typeBadge.hidden = true;
    els.mediaEyebrow.textContent = 'Now watching';
    els.mediaTitle.textContent = 'No video yet';
    updateSyncPill();
  }

  function applyMedia(media, opts) {
    opts = opts || {};
    const time = Math.max(0, Number(opts.time) || 0);
    const paused = opts.paused !== false;
    state.currentMedia = media;

    els.stageEmpty.classList.add('is-hidden');
    els.stageNotice.classList.remove('is-visible');
    els.tapOverlay.classList.remove('is-visible');
    els.yt.classList.toggle('is-active', media.type === 'youtube');
    els.mp4.classList.toggle('is-active', media.type === 'mp4');

    els.typeBadge.hidden = false;
    els.typeBadge.textContent = media.type === 'youtube' ? 'YouTube' : media.type === 'mp4' ? 'MP4' : 'Link';
    els.typeBadge.className = 'type-badge' + (media.type === 'youtube' ? ' youtube' : media.type === 'mp4' ? ' mp4' : '');
    els.mediaEyebrow.textContent = state.localOverride ? 'Watching locally' : 'Now watching';
    els.mediaTitle.textContent = mediaTitleFor(media);

    if (media.type === 'youtube') {
      loadYouTube(media, { time, paused });
    } else if (media.type === 'mp4') {
      loadMP4(media, { time, paused });
    } else {
      /* Not YouTube / not direct MP4: can't be synced. The room stays
         alive — chat works and the host can paste a proper link. */
      els.noticeUrl.textContent = media.url || '';
      els.stageNotice.classList.add('is-visible');
      stopLocalPlayers();
    }
    updateSyncPill();
  }

  function stopLocalPlayers() {
    try { if (!els.mp4.paused) els.mp4.pause(); els.mp4.removeAttribute('src'); els.mp4.load(); } catch (err) {}
    try { if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo(); } catch (err) {}
    hideTapOverlay();
  }

  /* ================= player: MP4 ================= */

  function loadMP4(media, opts) {
    const v = els.mp4;
    const url = media.url;
    let resolved = url;
    try { resolved = new URL(url, location.href).href; } catch (err) { /* keep as-is */ }

    if (v.src !== resolved) {
      v.src = url;
      const onMeta = () => {
        v.removeEventListener('loadedmetadata', onMeta);
        try { if (opts.time > 0.3) v.currentTime = opts.time; } catch (err) {}
        if (!opts.paused) { v.play().catch(showTapOverlay); }
      };
      v.addEventListener('loadedmetadata', onMeta);
      v.load();
    } else {
      try { if (Math.abs(v.currentTime - opts.time) > DRIFT_TOLERANCE) v.currentTime = opts.time; } catch (err) {}
      if (!opts.paused && v.paused) { v.play().catch(showTapOverlay); }
      if (opts.paused && !v.paused) v.pause();
    }
  }

  els.mp4.addEventListener('play', () => {
    hideTapOverlay();
    if (state.isHost) emitHostPlayback('play', els.mp4.currentTime);
  });
  els.mp4.addEventListener('pause', () => {
    if (state.isHost) emitHostPlayback('pause', els.mp4.currentTime);
  });
  els.mp4.addEventListener('seeked', () => {
    if (state.isHost) emitHostPlayback('seek', els.mp4.currentTime);
  });
  els.mp4.addEventListener('error', () => {
    if (state.currentMedia && state.currentMedia.type === 'mp4') {
      toast("Couldn't load this MP4 file.", 'error');
    }
  });

  /* ================= player: YouTube ================= */

  let ytApiPromise = null;
  let ytPlayer = null;
  let ytPendingApply = null;

  function ensureYouTubeAPI() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) { resolve(); return; }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') { try { prev(); } catch (err) {} }
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => { ytApiPromise = null; reject(new Error('YouTube API failed to load')); };
      document.head.appendChild(s);
      setTimeout(() => {
        if (!(window.YT && window.YT.Player)) { ytApiPromise = null; reject(new Error('YouTube API timeout')); }
      }, 12000);
    });
    return ytApiPromise;
  }

  async function loadYouTube(media, opts) {
    const videoId = parseYouTubeId(media.url);
    if (!videoId) {
      /* safety net if the server type disagrees with the URL */
      applyMedia({ type: 'unknown', url: media.url, title: media.title }, opts);
      return;
    }
    try {
      await ensureYouTubeAPI();
    } catch (err) {
      toast("Couldn't load the YouTube player.", 'error');
      return;
    }
    if (!ytPlayer) {
      ytPendingApply = { videoId, opts };
      ytPlayer = new YT.Player('yt-player', {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: {
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            const pending = ytPendingApply;
            ytPendingApply = null;
            if (pending) applyYouTubeVideo(pending.videoId, pending.opts);
          },
          onStateChange: onYouTubeStateChange,
          onError: () => toast("Couldn't load this YouTube video.", 'error'),
        },
      });
    } else {
      applyYouTubeVideo(videoId, opts);
    }
  }

  function applyYouTubeVideo(videoId, opts) {
    if (!ytPlayer) return;
    const t = Math.max(0, Number(opts.time) || 0);
    let currentVideoId = null;
    try { currentVideoId = ytPlayer.getVideoData() && ytPlayer.getVideoData().video_id; } catch (err) {}

    if (currentVideoId !== videoId) {
      /* per spec: paused -> cueVideoById, playing -> loadVideoById */
      if (opts.paused) {
        try { ytPlayer.cueVideoById({ videoId, startSeconds: t }); } catch (err) {}
      } else {
        try { ytPlayer.loadVideoById({ videoId, startSeconds: t }); } catch (err) {}
      }
    } else {
      try {
        const cur = ytPlayer.getCurrentTime() || 0;
        if (Math.abs(cur - t) > DRIFT_TOLERANCE) ytPlayer.seekTo(t, true);
      } catch (err) {}
    }
    /* then apply pause/play accordingly */
    try { if (opts.paused) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); } catch (err) {}
  }

  function onYouTubeStateChange(e) {
    const S = window.YT.PlayerState;
    if (e.data === S.PLAYING) {
      hideTapOverlay();
      if (state.isHost) emitHostPlayback('play', ytPlayer.getCurrentTime());
    } else if (e.data === S.PAUSED) {
      if (state.isHost) emitHostPlayback('pause', ytPlayer.getCurrentTime());
    } else if (e.data === S.ENDED) {
      if (state.isHost) emitHostPlayback('pause', ytPlayer.getDuration());
    }
  }

  /* ================= sync engine ================= */

  /* Room target position, extrapolated on the SERVER clock (skew
     corrected) so every client computes the same target. */
  function targetTime() {
    const ls = state.lastState;
    if (!ls) return 0;
    if (ls.paused) return ls.time;
    return ls.time + (Date.now() + state.clockSkew - ls.updatedAt) / 1000;
  }

  /* Non-hosts follow the room: pause/play + seek when drifting. */
  function syncPlayback() {
    if (state.isHost || state.localOverride || !state.currentMedia || !state.lastState) return;
    const paused = state.lastState.paused;
    const target = targetTime();

    if (state.currentMedia.type === 'mp4') {
      const v = els.mp4;
      try { if (Math.abs(v.currentTime - target) > DRIFT_TOLERANCE) v.currentTime = target; } catch (err) {}
      if (paused && !v.paused) v.pause();
      if (!paused && v.paused) v.play().catch(showTapOverlay);
    } else if (state.currentMedia.type === 'youtube' && ytPlayer) {
      try {
        const cur = ytPlayer.getCurrentTime() || 0;
        if (Math.abs(cur - target) > DRIFT_TOLERANCE) ytPlayer.seekTo(target, true);
        if (paused) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
      } catch (err) {}
    }
  }

  /* Host -> server playback updates */
  function emitHostPlayback(kind, time) {
    if (!wsReady() || !state.isHost || !state.roomId) return;
    wsSend({ type: kind, time: Math.max(0, Number(time) || 0) });
  }

  /* periodic drift correction + host YouTube seek detection */
  let lastHostYtTime = null;
  setInterval(() => {
    /* host: YouTube has no "seeked" event — detect time jumps
       (both while playing AND while paused) */
    if (state.isHost && state.currentMedia && state.currentMedia.type === 'youtube' && ytPlayer) {
      try {
        const cur = ytPlayer.getCurrentTime();
        const st = ytPlayer.getPlayerState();
        if (cur != null && st !== window.YT.PlayerState.UNSTARTED) {
          if (lastHostYtTime != null && Math.abs(cur - lastHostYtTime) > 1.8) {
            emitHostPlayback('seek', cur);
          }
          lastHostYtTime = cur;
        } else {
          lastHostYtTime = null;
        }
      } catch (err) { lastHostYtTime = null; }
    } else {
      lastHostYtTime = null;
    }

    /* non-host: follow the room */
    if (!state.isHost) syncPlayback();
    updateSyncPill();
  }, SYNC_INTERVAL);

  function updateSyncPill() {
    if (!state.roomId) { setSync('waiting', 'Waiting…'); return; }
    if (state.isHost) { setSync('host', 'You control playback'); return; }
    if (!state.currentMedia) { setSync('waiting', 'Waiting for video…'); return; }
    if (state.localOverride) { setSync('local', 'Local (not synced)'); return; }
    const ls = state.lastState;
    if (!ls) { setSync('waiting', 'Syncing…'); return; }

    let localTime = null;
    let localPaused = true;
    if (state.currentMedia.type === 'mp4') {
      localTime = els.mp4.currentTime || 0;
      localPaused = els.mp4.paused;
    } else if (state.currentMedia.type === 'youtube' && ytPlayer) {
      try { localTime = ytPlayer.getCurrentTime() || 0; localPaused = ytPlayer.getPlayerState() !== window.YT.PlayerState.PLAYING; } catch (err) {}
    }
    if (localTime == null) { setSync('waiting', 'Syncing…'); return; }

    const drift = Math.abs(localTime - targetTime());
    const pausedMatch = !!ls.paused === !!localPaused;
    if (pausedMatch && drift <= DRIFT_TOLERANCE) {
      setSync('synced', ls.paused ? 'Paused · in sync (' + fmtClock(localTime) + ')' : 'In sync · ' + fmtClock(localTime));
    } else {
      setSync('syncing', 'Syncing… ' + fmtClock(localTime));
    }
  }

  function setSync(kind, label) {
    els.syncPill.classList.toggle('is-synced', kind === 'synced');
    els.syncPill.classList.toggle('is-host', kind === 'host');
    els.syncLabel.textContent = label;
  }

  /* autoplay blocked -> "tap to start" overlay */
  function showTapOverlay() { els.tapOverlay.classList.add('is-visible'); }
  function hideTapOverlay() { els.tapOverlay.classList.remove('is-visible'); }
  els.tapOverlay.addEventListener('click', () => {
    hideTapOverlay();
    try {
      if (state.currentMedia && state.currentMedia.type === 'mp4') { els.mp4.muted = false; els.mp4.play().catch(() => {}); }
      else if (ytPlayer) { ytPlayer.playVideo(); }
    } catch (err) {}
  });

  /* ================= set video (host) / local paste (non-host) ================= */

  function hostSetVideo(url, title) {
    if (!wsReady()) { toast('Not connected yet…', 'error'); return; }
    const clean = String(url || '').trim();
    if (!clean) return;
    wsSend({
      type: 'set_media',
      media: { type: detectMediaType(clean), url: clean, title: String(title || '').slice(0, 120) },
    });
  }

  function localSetVideo(url) {
    /* Non-host: pasting a URL is LOCAL ONLY — it never changes the
       room media (the server rejects non-host set_media anyway). */
    const clean = String(url || '').trim();
    if (!clean) return;
    state.localOverride = true;
    applyMedia({ type: detectMediaType(clean), url: clean, title: '' }, { time: 0, paused: true, force: true });
    toast('Playing locally — only the host sets the video for everyone.');
    refreshHostUI();
  }

  els.mediaForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = els.mediaInput.value.trim();
    if (!url) { els.mediaInput.focus(); return; }
    if (state.isHost) hostSetVideo(url, '');
    else localSetVideo(url);
  });

  function refreshHostUI() {
    if (state.isHost) {
      els.setVideoBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/></svg> Set Video';
      els.hostHint.textContent = 'You are the host — your play, pause and seek control everyone. Paste a YouTube or direct MP4 link.';
      els.setVideoBtn.classList.add('btn-primary');
    } else {
      els.setVideoBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/></svg> Play locally';
      els.hostHint.textContent = state.hostId
        ? 'Only the host can set the room video. Pasting a link here plays it locally for you only.'
        : 'Waiting for the host… only the host can set the room video.';
      els.setVideoBtn.classList.add('btn-primary');
    }
  }

  /* ================= members ================= */

  function renderMembers(members) {
    els.membersRow.textContent = '';
    (members || []).forEach((m) => {
      const chip = document.createElement('span');
      chip.className = 'member-chip' + (m.id === state.hostId ? ' is-host' : '');
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = (m.name || 'G').charAt(0).toUpperCase();
      chip.appendChild(avatar);
      if (m.id === state.hostId) {
        const crown = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        crown.setAttribute('viewBox', '0 0 24 24');
        crown.setAttribute('class', 'crown');
        crown.setAttribute('aria-hidden', 'true');
        crown.innerHTML = '<path d="M5 16 3 5l5.5 5L12 3l3.5 7L21 5l-2 11zM4.5 19h15v2h-15z"/>';
        chip.appendChild(crown);
      }
      const name = document.createElement('span');
      name.textContent = m.name || 'Guest';
      chip.appendChild(name);
      if (m.id === state.myId) {
        const you = document.createElement('span');
        you.className = 'you-tag';
        you.textContent = 'you';
        chip.appendChild(you);
      }
      els.membersRow.appendChild(chip);
    });
  }

  /* ================= chat ================= */

  function appendChatMessage(msg) {
    if (els.chatEmpty && els.chatEmpty.parentNode) els.chatEmpty.remove();
    const wrap = document.createElement('div');
    /* System lines come from the worker as { name:"System", … } (and
       from this page as { system:true, … }) — render them without a
       message head. */
    const isSystem = !!(msg && (msg.system === true || msg.name === 'System'));
    const mine = !!(msg && msg.name === state.displayName && !isSystem);
    wrap.className = 'msg' + (isSystem ? ' is-system' : '') + (mine ? ' is-you' : '');

    if (!isSystem) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const name = document.createElement('span');
      name.className = 'msg-name';
      name.textContent = (msg && msg.name) || 'Guest';
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = new Date((msg && msg.ts) || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      head.append(name, time);
      wrap.appendChild(head);
    }
    const text = document.createElement('p');
    text.className = 'msg-text';
    text.textContent = (msg && msg.message) || '';
    wrap.appendChild(text);

    els.chatMessages.appendChild(wrap);
    while (els.chatMessages.children.length > 200) els.chatMessages.firstChild.remove();
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim().slice(0, 500);
    if (!text) return;
    if (!wsReady()) { toast('Not connected yet…', 'error'); return; }
    wsSend({ type: 'chat', message: text, ts: Date.now() });
    els.chatInput.value = '';
    els.chatInput.focus();
  });

  /* ================= invite ================= */

  els.copyInviteBtn.addEventListener('click', async () => {
    const link = els.inviteLink.value;
    if (!link) return;
    const ok = await copyText(link);
    toast(ok ? 'Invite link copied!' : 'Copy failed — select the link manually.', ok ? 'success' : 'error');
  });

  /* ================= join flow ================= */

  function showJoinError(message) {
    els.joinError.textContent = message;
    els.joinError.classList.add('is-visible');
  }
  function hideJoinError() { els.joinError.classList.remove('is-visible'); }

  /* ---- party backend URL: validation + save (join screen) ---- */

  function validateBackend(url) {
    if (!url) {
      return 'Enter your Party Backend URL (https://…workers.dev) and press Save.';
    }
    if (location.protocol === 'https:' && url.indexOf('http://') === 0) {
      return "HTTPS page can't connect to HTTP server. Use an https Party Backend URL.";
    }
    if (!/^(https?|wss?):\/\//i.test(url)) {
      return 'Party Backend URL must start with https:// (or wss://).';
    }
    return null;
  }

  /* "Join the Party" is only clickable with a valid backend URL. */
  function refreshJoinAvailability() {
    const candidate = normalizeBackend(els.backendInput.value) || BACKEND;
    const err = validateBackend(candidate);
    if (err) {
      els.joinBtn.disabled = true;
      showJoinError(err);
    } else {
      els.joinBtn.disabled = false;
      hideJoinError();
    }
  }

  function saveBackendUrl() {
    const value = normalizeBackend(els.backendInput.value);
    els.backendInput.value = value;
    try { localStorage.setItem(BACKEND_STORAGE_KEY, value); } catch (err) {}
    BACKEND = value || DEFAULT_BACKEND;
    refreshJoinAvailability();
    if (!validateBackend(BACKEND)) {
      toast('Party backend URL saved.', 'success');
      /* optional liveness probe — purely informational */
      checkBackendHealth(BACKEND);
    }
  }

  async function checkBackendHealth(base) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(httpBase(base) + '/health', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('bad status');
      toast('Backend reachable — ready to join.', 'success');
    } catch (err) {
      toast("Saved, but the backend didn't respond at " + base + ' — is your worker deployed?', 'error');
    }
  }

  els.saveBackendBtn.addEventListener('click', saveBackendUrl);
  els.backendInput.addEventListener('input', refreshJoinAvailability);
  els.backendInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBackendUrl(); }
  });

  async function startParty() {
    if (state.joined) return;
    const backendError = validateBackend(BACKEND);
    if (backendError) {
      els.joinBtn.disabled = true;
      showJoinError(backendError);
      els.backendInput.focus();
      return;
    }
    const name = (els.nameInput.value || '').trim().slice(0, 24) || randomGuestName();
    try { localStorage.setItem('zeus_party_name', name); } catch (err) {}

    els.joinBtn.disabled = true;
    els.joinBtn.textContent = 'Connecting…';
    hideJoinError();

    try {
      if (!state.roomId) {
        state.roomId = await createRoom();  /* also validates the backend early */
        updateUrlWithRoom();
      }
      state.displayName = name;
      state.everConnected = false;
      state.reconnectAttempts = 0;
      renderRoomBadges();
      connectSocket();
      state.joined = true;
      els.joinOverlay.classList.add('is-hidden');
      appendChatMessage({ system: true, name: 'System', message: 'Welcome to the party! Invite friends with the link below the player.' });
    } catch (err) {
      state.roomId = paramRoom || null;
      showJoinError(
        "Can't reach the party backend at " + BACKEND + '. ' +
        'Check the URL above and make sure your worker is deployed (cd party-worker && npx wrangler deploy).'
      );
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = 'Join the Party';
      setConn('error', "Can't reach backend");
    }
  }

  els.joinBtn.addEventListener('click', startParty);
  els.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); startParty(); }
  });

  /* ================= boot ================= */

  (function boot() {
    let saved = '';
    try { saved = localStorage.getItem('zeus_party_name') || ''; } catch (err) {}
    els.nameInput.value = saved || randomGuestName();
    els.backendInput.value = BACKEND; /* saved backend URL or the default worker URL */
    els.joinMeta.innerHTML = paramRoom
      ? 'Joining room <strong>' + paramRoom + '</strong>'
      : 'A new room will be created for you.';
    resetStage();
    renderRoomBadges();
    setConn('connecting', 'Connecting…');
    refreshHostUI();
    refreshJoinAvailability();
    setTimeout(() => {
      (els.joinBtn.disabled ? els.backendInput : els.nameInput).focus();
    }, 150);
  })();

  /* Debug/testing handle (harmless in production) */
  window.ZEUSParty = {
    state,
    get ws() { return state.ws; },
    get ytPlayer() { return ytPlayer; },
    mp4: els.mp4,
    setMedia: hostSetVideo,
    sync: syncPlayback,
    detectMediaType,
    parseYouTubeId,
    get backend() { return BACKEND; },
    validateBackend,
    saveBackendUrl,
  };

})();
