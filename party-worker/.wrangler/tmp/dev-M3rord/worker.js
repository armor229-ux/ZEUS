var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
var ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}
__name(randomId, "randomId");
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS)
  });
}
__name(json, "json");
function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}
__name(cleanText, "cleanText");
function parseYouTubeId(url) {
  if (typeof url !== "string") return null;
  const patterns = [
    /youtu\.be\/([\w-]{11})(?:[?&#]|$)/,
    /[?&]v=([\w-]{11})(?:[&]|$)/,
    /youtube\.com\/embed\/([\w-]{11})(?:[?&#]|$)/,
    /youtube\.com\/shorts\/([\w-]{11})(?:[?&#]|$)/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
__name(parseYouTubeId, "parseYouTubeId");
function detectMediaType(url) {
  const u = (url || "").trim();
  if (!u) return "unknown";
  if (parseYouTubeId(u)) return "youtube";
  if (/\.mp4([?#]|$)/i.test(u)) return "mp4";
  return "unknown";
}
__name(detectMediaType, "detectMediaType");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true });
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return json({ roomId: randomId(6) });
    }
    if (url.pathname === "/ws") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed \u2014 use GET for the WebSocket upgrade." }, 405);
      }
      const room = (url.searchParams.get("room") || "").trim();
      if (!room) {
        return json({ error: "Missing ?room= parameter." }, 400);
      }
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "Expected a WebSocket upgrade request." }, 426);
      }
      const roomId = env.PARTY_ROOM.idFromName(room.toUpperCase());
      return env.PARTY_ROOM.get(roomId).fetch(request);
    }
    return json({ error: "Not found" }, 404);
  }
};
var PartyRoom = class {
  static {
    __name(this, "PartyRoom");
  }
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
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
    }
  }
  async save() {
    try {
      await this.storage.put("room", {
        media: this.media,
        paused: this.paused,
        time: this.time,
        updatedAt: this.updatedAt
      });
    } catch (err) {
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
      members: this.memberList()
    };
  }
  async fetch(request) {
    await this.load();
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade request." }, 426);
    }
    const url = new URL(request.url);
    const name = cleanText(url.searchParams.get("name"), 24) || "Guest";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const session = { id: "m" + randomId(6), name, ws: server };
    this.attach(session);
    return new Response(null, { status: 101, webSocket: client });
  }
  attach(session) {
    this.sessions.set(session.id, session);
    if (!this.hostId || !this.sessions.has(this.hostId)) {
      this.hostId = session.id;
    }
    const ws = session.ws;
    const self = this;
    ws.addEventListener("message", (event) => {
      self.onMessage(session, event.data).catch(() => {
      });
    });
    ws.addEventListener("close", () => self.onClose(session));
    ws.addEventListener("error", () => self.onClose(session));
    this.send(session, {
      type: "state",
      state: this.snapshot(),
      you: session.id,
      serverNow: Date.now()
    });
    this.broadcast({ type: "members", members: this.memberList() });
    this.broadcast({ type: "host", hostId: this.hostId });
  }
  send(session, msg) {
    try {
      session.ws.send(JSON.stringify(msg));
    } catch (err) {
    }
  }
  broadcast(msg) {
    const frame = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      try {
        s.ws.send(frame);
      } catch (err) {
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
        const name = cleanText(msg.name, 24);
        if (name && name !== session.name) {
          session.name = name;
          this.broadcast({ type: "members", members: this.memberList() });
        }
        this.send(session, {
          type: "state",
          state: this.snapshot(),
          you: session.id,
          serverNow: Date.now()
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
        const url = cleanText(m.url, 2e3);
        if (!/^https?:\/\//i.test(url)) {
          this.send(session, { type: "error", message: "Media URL must start with http:// or https://." });
          return;
        }
        const type = ["youtube", "mp4", "unknown"].indexOf(m.type) !== -1 ? m.type : detectMediaType(url);
        this.media = { type, url, title: cleanText(m.title, 120) };
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
          ts: Number(msg.ts) || Date.now()
        });
        return;
      }
      default:
        return;
    }
  }
  onClose(session) {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
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
          ts: Date.now()
        });
      }
    }
    this.broadcast({ type: "members", members: this.memberList() });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-3dwFRF/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-3dwFRF/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  PartyRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
