/* ============================================================
   ZEUS — party-worker/src/worker.js
   Cloudflare Worker + Durable Object backend for ZEUS Watch Party.

   Endpoints (stateless, handled by the Worker itself):
     POST /api/rooms            -> { roomId }   (random short id)
     GET  /health               -> { ok: true }
     GET  /ws?room=ID&name=NAME -> 101 WebSocket upgrade, routed into
                                    the PartyRoom Durable Object for
                                    that room id.

   Message protocol (JSON over WebSocket):
     client -> server:  { type:"join", name }
                        { type:"set_media", media:{type,url,title} }  (host only)
                        { type:"play",  time }
                        { type:"pause", time }
                        { type:"seek",  time }
                        { type:"chat",  message, ts }
                        { type:"ping" }                              (keep-alive)

     server -> client:  { type:"state",   state }      (on join + after updates)
                        { type:"members", members }
                        { type:"host",    hostId }
                        { type:"chat",    name, message, ts }
                        { type:"error",   message }
                        { type:"pong" }

   Room state held by the Durable Object:
     { media:{type:"youtube"|"mp4"|"unknown", url, title},
       paused:boolean, time:number, updatedAt:number,
       hostId:string|null, members:[{id,name}] }

   Host rules:  first connected client becomes the host; when the host
   disconnects the next connected member becomes the host; only the
   host can set_media (others get an error) — playback events are host
   driven as well (non-hosts follow the room state).

   Sync rules:  play/pause/seek update { paused, time, updatedAt } and
   broadcast the full state, so every client can extrapolate the
   correct position (time + now - updatedAt).

   CORS is open ("*") so the worker works from BOTH Cloudflare Pages
   and Vercel deployments (WebSockets are not CORS-restricted anyway).
============================================================ */

/* ---------- shared helpers ---------- */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* Short, look-alike-free room codes (no 0/O, 1/I/L). */
const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS),
  });
}

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

/* Server-side media detection (mirrors the client). */
function parseYouTubeId(url) {
  if (typeof url !== "string") return null;
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
  const u = (url || "").trim();
  if (!u) return "unknown";
  if (parseYouTubeId(u)) return "youtube";
  if (/\.mp4([?#]|$)/i.test(u)) return "mp4";
  return "unknown";
}

/* ---------- worker (routing) ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* CORS preflight — lets Pages/Vercel frontends call the REST endpoints. */
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      /* Room ids are random short ids; the Durable Object instance is
         created lazily on the first /ws connection for that id. */
      return json({ roomId: randomId(6) });
    }

    if (url.pathname === "/ws") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed — use GET for the WebSocket upgrade." }, 405);
      }
      const room = (url.searchParams.get("room") || "").trim();
      if (!room) {
        return json({ error: "Missing ?room= parameter." }, 400);
      }
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "Expected a WebSocket upgrade request." }, 426);
      }
      /* Route the connection into the PartyRoom instance for this room.
         idFromName() is case-sensitive — normalize so "ab12" and "AB12"
         land in the same room. */
      const roomId = env.PARTY_ROOM.idFromName(room.toUpperCase());
      return env.PARTY_ROOM.get(roomId).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
};

/* ---------- Durable Object: one instance per party room ---------- */

export class PartyRoom {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map(); /* memberId -> { id, name, ws } */
    this.loaded = false;
    this.media = null;
    this.paused = true;
    this.time = 0;
    this.updatedAt = 0;
    this.hostId = null;
  }

  /* Media/position survive Durable Object restarts via storage.
     (members + host are transient — they only exist while connected). */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = await this.storage.get("room");
      if (stored) {
        this.media = stored.media || null;
        this.paused = stored.paused !== false;
        this.time = Number(stored.time) || 0;
        this.updatedAt = Number(stored.updatedAt) || 0;
      }
    } catch (err) {
      /* storage read failed — start with a fresh room */
    }
  }

  async save() {
    try {
      await this.storage.put("room", {
        media: this.media,
        paused: this.paused,
        time: this.time,
        updatedAt: this.updatedAt,
      });
    } catch (err) {
      /* non-fatal — the in-memory room keeps working */
    }
  }

  memberList() {
    const list = [];
    for (const s of this.sessions.values()) list.push({ id: s.id, name: s.name });
    return list;
  }

  snapshot() {
    return {
      media: this.media,
      paused: this.paused,
      time: this.time,
      updatedAt: this.updatedAt,
      hostId: this.hostId,
      members: this.memberList(),
    };
  }

  async fetch(request) {
    await this.load();

    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade request." }, 426);
    }

    /* The display name may arrive both via the ?name= query param and
       via the { type:"join", name } protocol message. */
    const url = new URL(request.url);
    const name = cleanText(url.searchParams.get("name"), 24) || "Guest";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    /* The server side must be accepted BEFORE any send() / listener
       registration — otherwise messages sent before the 101 response
       completes are dropped. */
    server.accept();

    const session = { id: "m" + randomId(6), name: name, ws: server };
    this.attach(session);

    return new Response(null, { status: 101, webSocket: client });
  }

  attach(session) {
    this.sessions.set(session.id, session);

    /* First connected client becomes the host (also repairs a stale
       hostId after a Durable Object restart). */
    if (!this.hostId || !this.sessions.has(this.hostId)) {
      this.hostId = session.id;
    }

    const ws = session.ws;
    const self = this;
    ws.addEventListener("message", (event) => {
      self.onMessage(session, event.data).catch(() => {});
    });
    ws.addEventListener("close", () => self.onClose(session));
    ws.addEventListener("error", () => self.onClose(session));

    /* Initial snapshot for the new client — "you" tells the client its
       own member id so it can tell whether it is the host. */
    this.send(session, {
      type: "state",
      state: this.snapshot(),
      you: session.id,
      serverNow: Date.now(),
    });
    this.broadcast({ type: "members", members: this.memberList() });
    this.broadcast({ type: "host", hostId: this.hostId });
  }

  send(session, msg) {
    try {
      session.ws.send(JSON.stringify(msg));
    } catch (err) {
      /* socket is dying — onClose will clean it up */
    }
  }

  broadcast(msg) {
    const frame = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      try {
        s.ws.send(frame);
      } catch (err) {
        /* ignore — onClose cleans up */
      }
    }
  }

  /* Sync rule: every state change broadcasts the full snapshot so all
     clients can re-sync (extrapolated from time + updatedAt). */
  broadcastState() {
    this.broadcast({ type: "state", state: this.snapshot(), serverNow: Date.now() });
  }

  async onMessage(session, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      this.send(session, { type: "error", message: "Invalid JSON message." });
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "ping":
        this.send(session, { type: "pong" });
        return;

      case "join": {
        /* protocol join — confirms/updates the display name */
        const name = cleanText(msg.name, 24);
        if (name && name !== session.name) {
          session.name = name;
          this.broadcast({ type: "members", members: this.memberList() });
        }
        this.send(session, {
          type: "state",
          state: this.snapshot(),
          you: session.id,
          serverNow: Date.now(),
        });
        this.send(session, { type: "host", hostId: this.hostId });
        return;
      }

      case "set_media": {
        if (session.id !== this.hostId) {
          this.send(session, { type: "error", message: "Only the host can set the room video." });
          return;
        }
        const m = msg.media || {};
        const url = cleanText(m.url, 2000);
        if (!/^https?:\/\//i.test(url)) {
          this.send(session, { type: "error", message: "Media URL must start with http:// or https://." });
          return;
        }
        const type = ["youtube", "mp4", "unknown"].indexOf(m.type) !== -1 ? m.type : detectMediaType(url);
        this.media = { type: type, url: url, title: cleanText(m.title, 120) };
        this.paused = true;
        this.time = 0;
        this.updatedAt = Date.now();
        await this.save();
        this.broadcastState();
        return;
      }

      case "play":
      case "pause":
      case "seek": {
        if (session.id !== this.hostId) {
          this.send(session, { type: "error", message: "Only the host controls playback." });
          return;
        }
        const time = Math.max(0, Number(msg.time) || 0);
        this.time = time;
        if (msg.type === "play") this.paused = false;
        else if (msg.type === "pause") this.paused = true;
        /* "seek" keeps the paused flag unchanged */
        this.updatedAt = Date.now();
        await this.save();
        this.broadcastState();
        return;
      }

      case "chat": {
        const text = cleanText(msg.message, 500);
        if (!text) return;
        this.broadcast({
          type: "chat",
          name: session.name,
          message: text,
          ts: Number(msg.ts) || Date.now(),
        });
        return;
      }

      default:
        /* unknown message types are ignored */
        return;
    }
  }

  onClose(session) {
    if (!this.sessions.has(session.id)) return; /* close + error can both fire */
    this.sessions.delete(session.id);

    /* Host migration: the next still-connected member becomes the host. */
    if (this.hostId === session.id) {
      let next = null;
      for (const s of this.sessions.values()) {
        next = s;
        break;
      }
      this.hostId = next ? next.id : null;
      this.broadcast({ type: "host", hostId: this.hostId });
      if (next) {
        this.broadcast({
          type: "chat",
          name: "System",
          message: next.name + " is now hosting the party.",
          ts: Date.now(),
        });
      }
    }

    this.broadcast({ type: "members", members: this.memberList() });
  }
}
