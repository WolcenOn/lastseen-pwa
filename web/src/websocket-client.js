export const SOCKET_STATES = Object.freeze({
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  OFFLINE: "offline",
  CLOSED: "closed"
});

const DEFAULT_BACKOFF_MS = Object.freeze({
  initial: 1000,
  factor: 2,
  max: 30000,
  jitter: 0.2
});

export function createReconnectBackoff(options = {}) {
  const config = {
    ...DEFAULT_BACKOFF_MS,
    ...options
  };

  return attempt => {
    const safeAttempt = Math.max(0, Number(attempt) || 0);
    const base = Math.min(config.max, config.initial * (config.factor ** safeAttempt));
    if (!config.jitter) return Math.round(base);

    const random = typeof config.random === "function" ? config.random() : Math.random();
    const boundedRandom = Math.max(0, Math.min(1, random));
    const spread = base * config.jitter;
    return Math.round(Math.max(0, base - spread + (spread * 2 * boundedRandom)));
  };
}

export class ReconnectingWebSocketClient {
  constructor(options) {
    if (!options?.urlFactory) throw new Error("urlFactory is required");

    this.urlFactory = options.urlFactory;
    this.WebSocketClass = options.WebSocketClass || globalThis.WebSocket;
    this.setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    this.backoff = options.backoff || createReconnectBackoff();
    this.maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : Infinity;
    this.parseMessage = options.parseMessage || (event => JSON.parse(event.data));

    this.socket = null;
    this.state = SOCKET_STATES.CLOSED;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.closedIntentionally = true;
    this.latestPosition = null;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
  }

  connect() {
    this.closedIntentionally = false;
    this.reconnectAttempts = 0;
    this.#open(SOCKET_STATES.CONNECTING);
  }

  close(reason = "manual") {
    this.closedIntentionally = true;
    this.#clearReconnectTimer();
    this.#setState(SOCKET_STATES.CLOSED, { reason });

    if (this.socket && this.socket.readyState <= 1) {
      try {
        this.socket.close(1000, reason);
      } catch {
        // Ignore close failures from platform WebSocket implementations.
      }
    }
  }

  markRoomEnded() {
    this.close("room-ended");
  }

  updateLatestPosition(position) {
    this.latestPosition = position || null;
  }

  sendJSON(payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  #open(nextState) {
    if (!this.WebSocketClass) {
      this.#setState(SOCKET_STATES.OFFLINE, { reason: "websocket-unavailable" });
      return;
    }

    this.#setState(nextState);

    const url = this.urlFactory();
    const socket = new this.WebSocketClass(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closedIntentionally) return;
      this.reconnectAttempts = 0;
      this.#setState(SOCKET_STATES.CONNECTED);
      if (this.latestPosition) {
        this.#emit("resend-position", this.latestPosition);
      }
    });

    socket.addEventListener("message", event => {
      if (this.socket !== socket || this.closedIntentionally) return;
      try {
        this.#emit("message", this.parseMessage(event));
      } catch (error) {
        this.#emit("parse-error", error);
      }
    });

    socket.addEventListener("error", event => {
      if (this.socket !== socket || this.closedIntentionally) return;
      this.#emit("socket-error", event);
    });

    socket.addEventListener("close", event => {
      if (this.socket !== socket) return;
      if (this.closedIntentionally) {
        this.#setState(SOCKET_STATES.CLOSED, { code: event.code, reason: event.reason });
        return;
      }
      this.#scheduleReconnect(event);
    });
  }

  #scheduleReconnect(event) {
    if (this.reconnectAttempts >= this.maxAttempts) {
      this.#setState(SOCKET_STATES.OFFLINE, { code: event?.code, reason: event?.reason });
      return;
    }

    const attempt = this.reconnectAttempts;
    const delay = this.backoff(attempt);
    this.reconnectAttempts += 1;
    this.#setState(SOCKET_STATES.RECONNECTING, { attempt: this.reconnectAttempts, delay, code: event?.code, reason: event?.reason });
    this.#clearReconnectTimer();
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedIntentionally) this.#open(SOCKET_STATES.RECONNECTING);
    }, delay);
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      this.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #setState(state, detail = {}) {
    if (this.state === state && Object.keys(detail).length === 0) return;
    this.state = state;
    this.#emit("state", { state, ...detail });
  }

  #emit(type, detail) {
    const event = { type, detail };
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}
