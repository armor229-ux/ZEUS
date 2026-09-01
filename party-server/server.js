/* ============================================================
   ZEUS Party — party-server/server.js
   Standalone Express + Socket.IO server for ZEUS Watch Party.

   REST API:
     POST /api/rooms            -> { roomId }          (create a room)
     GET  /api/rooms/:roomId    -> room snapshot / 404 (validate invite links)
     GET  /health               -> { ok: true }        (liveness probe)
     GET  /api/health           -> { ok, rooms }

   Socket.IO events:
     client -> server : join      { roomId, displayName }
                        set_media { roomId, media: { type, url, title } }  (host only)
                        play      { roomId, time }                         (host only)
                        pause     { roomId, time }                         (host only)
                        seek      { roomId, time }                         (host only)
                        chat      { roomId, message }
                        get_state {}
                        leave_party {}
     server -> client : state     (full room snapshot)
                        host      { hostSocketId }
                        members   { members: [{ socketId, displayName, joinedAt }] }
                        set_media { roomId, media }
                        play / pause / seek { roomId, time }
                        chat      { roomId, message, displayName, ts, system? }
                        party-error { message }

   Room state (in-memory):
     { roomId, hostSocketId, media, paused, time, updatedAt, members: [] }

   - First member to join becomes the host; if the host disconnects
     the next member takes over (with a system chat message).
   - Drift correction: every play/pause/seek stamps room.time +
     room.updatedAt; joins and resyncs receive a freshly extrapolated
     snapshot and each client adjusts locally (see party.js).
   - Media type ("youtube" | "mp4" | "unknown") is re-derived on the
     server from the URL so every member always agrees.

   Env:
     PORT                default 5050
     PARTY_CORS_ORIGIN   default "*" (comma-separated list allowed)

   Static hosting: the main ZEUS site is already served by Next.js on
   port 3000, but serving ../public is easy, so this server can also
   run standalone (open http://localhost:5050/party.html directly).

   Client note: browsers connect directly to the party server URL they
   configured on the party.html join screen — io("http://localhost:5050")
   in local dev, or the deployed https:// URL (an https page can never
   reach an http:// server, so deployments must serve https). The
   engine.io endpoint stays on the default /socket.io path, which this
   server uses (do not change it).
============================================================ */

'use strict';

const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const PORT = process.env.PORT || 5050;
const PARTY_CORS_ORIGIN = process.env.PARTY_CORS_ORIGIN || '*';

/* Room codes: 6 chars, no look-alikes (no 0/O, 1/I). */
const newRoomId = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

/* ================= app + REST ================= */

const app = express();
app.use(express.json());

/* CORS for the REST endpoints (Socket.IO has its own config below). */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', PARTY_CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

/* ================= rooms (in-memory) ================= */

const rooms = new Map();

function createRoom(roomId) {
  const room = {
    roomId,
    hostSocketId: null,
    media: null, /* { type: 'youtube'|'mp4'|'unknown', url, title } */
    paused: true,
    time: 0,
    updatedAt: Date.now(),
    members: [], /* [{ socketId, displayName, joinedAt }] */
  };
  rooms.set(roomId, room);
  return room;
}

function isYouTubeUrl(url) {
  try {
    const u = new URL(url, 'https://example.invalid');
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return true;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      return (
        u.searchParams.has('v') ||
        u.pathname.startsWith('/embed/') ||
        u.pathname.startsWith('/shorts/')
      );
    }
    return false;
  } catch (err) {
    return false;
  }
}

/* Same detection rules as party.js — re-derived server-side. */
function detectMediaType(url) {
  if (typeof url !== 'string') return 'unknown';
  const u = url.trim();
  if (isYouTubeUrl(u)) return 'youtube';
  if (/\.mp4([?#]|$)/i.test(u)) return 'mp4';
  return 'unknown';
}

/* Room time extrapolated to "now" — the drift-correction source. */
function roomTime(room) {
  if (room.paused) return room.time;
  return room.time + Math.max(0, Date.now() - room.updatedAt) / 1000;
}

function publicRoom(room) {
  return {
    roomId: room.roomId,
    hostSocketId: room.hostSocketId,
    media: room.media,
    paused: room.paused,
    time: roomTime(room),
    updatedAt: room.updatedAt,
    members: room.members.slice(),
  };
}

function sanitizeName(name) {
  const n = String(name == null ? '' : name).trim().slice(0, 24);
  return n || 'Guest';
}

/* Re-stamp the room timeline (called on every playback change). */
function stampRoom(room, time, paused) {
  room.time = Math.max(0, Number(time) || 0);
  room.paused = !!paused;
  room.updatedAt = Date.now();
}

/* ================= REST routes ================= */

app.post('/api/rooms', (req, res) => {
  const roomId = newRoomId();
  createRoom(roomId);
  console.log(`[party] room created: ${roomId}`);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(String(req.params.roomId).trim());
  if (!room) { res.status(404).json({ error: 'room not found' }); return; }
  res.json(publicRoom(room));
});

/* Liveness probe — always { ok: true } while the server is up. */
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

/* Serve the main site statically (easy + useful for standalone runs;
   the sandbox gateway/Next.js serves the same files in production). */
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ================= HTTP + Socket.IO ================= */

const httpServer = app.listen(PORT, () => {
  console.log(`[party] ZEUS party server listening on port ${PORT}`);
});

const io = new Server(httpServer, {
  /* Default engine path (/socket.io) — matches io("<party-server-url>")
     clients. CORS is env-configurable via PARTY_CORS_ORIGIN ("*" by
     default, so any deployed ZEUS front-end can connect). */
  cors: {
    origin: PARTY_CORS_ORIGIN === '*'
      ? '*'
      : PARTY_CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

function roomOf(socket) {
  return socket.data.roomId ? rooms.get(socket.data.roomId) : null;
}

function systemChat(room, message) {
  io.to(room.roomId).emit('chat', {
    roomId: room.roomId,
    message,
    displayName: 'System',
    system: true,
    ts: Date.now(),
  });
}

/* ================= connection handling ================= */

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.displayName = null;

  /* ---- join { roomId, displayName } ---- */
  socket.on('join', (data) => {
    const roomId = String((data && data.roomId) || '').trim();
    if (!roomId) {
      socket.emit('party-error', { message: 'Missing room id.' });
      return;
    }
    const displayName = sanitizeName(data && data.displayName);

    leaveRoom(socket); /* leave any previous room first */

    /* Resilient rejoin: rooms are in-memory, so a server restart or a
       shared invite link for a room that no longer exists simply
       (re-)creates it — the first member becomes the host. */
    const room = rooms.get(roomId) || createRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.displayName = displayName;
    room.members.push({ socketId: socket.id, displayName, joinedAt: Date.now() });

    const becameHost = room.hostSocketId === null;
    if (becameHost) room.hostSocketId = socket.id;

    /* Initial snapshot for the joiner */
    socket.emit('state', publicRoom(room));
    socket.emit('host', { hostSocketId: room.hostSocketId });
    socket.emit('members', { members: room.members.slice() });

    /* Room-wide updates */
    io.to(roomId).emit('members', { members: room.members.slice() });
    systemChat(room, `${displayName} joined the party${becameHost ? ' and is hosting' : ''}`);

    console.log(`[party] ${displayName} (${socket.id}) joined ${roomId}${becameHost ? ' as host' : ''}`);
  });

  /* ---- set_media { roomId, media } (host only) ---- */
  socket.on('set_media', (data) => {
    const room = roomOf(socket);
    if (!room) return;
    if (room.hostSocketId !== socket.id) {
      socket.emit('party-error', { message: 'Only the host can set the room video.' });
      return;
    }
    const media = (data && data.media) || {};
    const url = typeof media.url === 'string' ? media.url.trim() : '';
    if (!url) {
      socket.emit('party-error', { message: 'Missing video URL.' });
      return;
    }
    room.media = {
      type: detectMediaType(url),
      url,
      title: typeof media.title === 'string' ? media.title.slice(0, 120) : '',
    };
    stampRoom(room, 0, true); /* new video: rewind + start paused */
    io.to(room.roomId).emit('set_media', { roomId: room.roomId, media: room.media });
    io.to(room.roomId).emit('state', publicRoom(room));
    console.log(`[party] ${room.roomId} media -> ${room.media.type} ${url.slice(0, 80)}`);
  });

  /* ---- play / pause / seek { roomId, time } (host only) ---- */
  socket.on('play', (data) => {
    const room = roomOf(socket);
    if (!room || room.hostSocketId !== socket.id) return;
    stampRoom(room, data && data.time, false);
    socket.to(room.roomId).emit('play', { roomId: room.roomId, time: room.time });
    io.to(room.roomId).emit('state', publicRoom(room));
  });

  socket.on('pause', (data) => {
    const room = roomOf(socket);
    if (!room || room.hostSocketId !== socket.id) return;
    stampRoom(room, data && data.time, true);
    socket.to(room.roomId).emit('pause', { roomId: room.roomId, time: room.time });
    io.to(room.roomId).emit('state', publicRoom(room));
  });

  socket.on('seek', (data) => {
    const room = roomOf(socket);
    if (!room || room.hostSocketId !== socket.id) return;
    stampRoom(room, data && data.time, room.paused); /* keeps play/pause state */
    socket.to(room.roomId).emit('seek', { roomId: room.roomId, time: room.time });
    io.to(room.roomId).emit('state', publicRoom(room));
  });

  /* ---- chat { roomId, message } (everyone) ---- */
  socket.on('chat', (data) => {
    const room = roomOf(socket);
    if (!room) return;
    const message = String((data && data.message) || '').trim().slice(0, 500);
    if (!message) return;
    io.to(room.roomId).emit('chat', {
      roomId: room.roomId,
      message,
      displayName: socket.data.displayName || 'Guest',
      ts: Date.now(),
    });
  });

  /* ---- get_state {} : fresh snapshot on demand (resync) ---- */
  socket.on('get_state', () => {
    const room = roomOf(socket);
    if (room) socket.emit('state', publicRoom(room));
  });

  /* ---- explicit leave + disconnect (with host migration) ---- */
  socket.on('leave_party', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  socket.data.roomId = null;

  const name = socket.data.displayName || 'Guest';
  socket.leave(roomId);

  const room = rooms.get(roomId);
  if (!room) return;

  room.members = room.members.filter((m) => m.socketId !== socket.id);

  if (room.hostSocketId === socket.id) {
    room.hostSocketId = room.members.length ? room.members[0].socketId : null;
    io.to(roomId).emit('host', { hostSocketId: room.hostSocketId });
    if (room.hostSocketId) {
      systemChat(room, `${room.members[0].displayName} is now hosting`);
    }
  }

  if (room.members.length) {
    io.to(roomId).emit('members', { members: room.members.slice() });
    systemChat(room, `${name} left the party`);
  } else {
    rooms.delete(roomId); /* empty room: free the memory (rejoin recreates) */
  }

  console.log(`[party] ${name} (${socket.id}) left ${roomId}`);
}

/* ================= graceful shutdown ================= */

function shutdown() {
  console.log('[party] shutting down…');
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
