const NativeWebSocket = globalThis.WebSocket;

function apiBaseURL() {
  const configured = globalThis.LASTSEEN_API_BASE_URL;
  if (typeof configured === "string" && configured.trim()) {
    return configured.replace(/\/$/, "");
  }
  return globalThis.location?.origin || "";
}

function parseLegacyJoinURL(rawURL) {
  let url;
  try {
    url = new URL(String(rawURL), globalThis.location?.href || undefined);
  } catch {
    return null;
  }

  const marker = "/ws/rooms/";
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0 || url.searchParams.has("token")) return null;

  const roomID = decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
  const nickname = url.searchParams.get("nick") || "";
  const pin = url.searchParams.get("pin") || "";
  const avatar = url.searchParams.get("avatar") || "";
  const clientID = url.searchParams.get("id") || "";

  if (!roomID || !nickname || !pin) return null;

  return { roomID, nickname, pin, avatar, clientID, creatorToken: readCreatorToken(roomID) };
}

function readCreatorToken(roomID) {
  if (!roomID) return "";

  const stateKey = `lastseen:${roomID}:state`;
  const tokenKey = `lastseen:${roomID}:creator-token`;

  try {
    const state = JSON.parse(globalThis.localStorage?.getItem(stateKey) || "{}");
    if (typeof state?.creatorToken === "string" && state.creatorToken.trim()) return state.creatorToken.trim();
  } catch {
    // Ignore malformed local room state and try backup keys below.
  }

  try {
    const localToken = globalThis.localStorage?.getItem(tokenKey) || "";
    if (localToken.trim()) return localToken.trim();
  } catch {
    // Ignore storage access errors.
  }

  try {
    const sessionToken = globalThis.sessionStorage?.getItem(tokenKey) || "";
    if (sessionToken.trim()) return sessionToken.trim();
  } catch {
    // Ignore storage access errors.
  }

  return "";
}

function persistJoinContract(roomID, contract) {
  if (!roomID || !contract) return;

  const publicContract = {
    role: contract.role || "participant",
    capabilities: contract.capabilities || {},
    protocolVersion: contract.protocolVersion || "",
    features: contract.features || {},
    joinedAt: new Date().toISOString()
  };

  globalThis.__lastSeenJoinContract = { roomID, ...publicContract };

  try {
    const stateKey = `lastseen:${roomID}:state`;
    const state = JSON.parse(globalThis.localStorage?.getItem(stateKey) || "{}");
    state.role = publicContract.role;
    state.capabilities = publicContract.capabilities;
    state.protocolVersion = publicContract.protocolVersion || state.protocolVersion || "";
    state.joinFeatures = publicContract.features;
    state.lastJoinContractAt = publicContract.joinedAt;
    globalThis.localStorage?.setItem(stateKey, JSON.stringify(state));
  } catch {
    // Capabilities are still dispatched even if storage is unavailable.
  }

  try {
    globalThis.dispatchEvent(new CustomEvent("lastseen:join-contract", {
      detail: { roomID, contract: publicContract }
    }));
  } catch {
    // Older browsers may not support CustomEvent construction in every context.
  }
}

function bridgeStatus(message) {
  const status = document.querySelector("#status");
  const roomStatus = document.querySelector("#room-status");
  if (status) status.textContent = message;
  if (roomStatus) roomStatus.textContent = message;
}

function restoreJoinUI() {
  const joinCard = document.querySelector("#join-card");
  const roomCard = document.querySelector("#room-card");
  const joinButton = document.querySelector("#join-room");
  if (joinCard) joinCard.hidden = false;
  if (roomCard) roomCard.hidden = true;
  if (joinButton) joinButton.disabled = false;
}

function errorMessageForJoinFailure(status, body) {
  const code = String(body || "").trim();
  if (status === 409 || code === "nickname_taken") return "Ese mote ya está en uso en esta sala. Elige otro.";
  if (status === 410 || code === "room_closed") return "La sala ya no está disponible.";
  if (status === 429 || code === "room_full") return "La sala está llena para el plan gratuito.";
  if (status === 404) return "Sala no encontrada.";
  return "No se pudo validar la entrada a la sala.";
}

class TokenBridgeWebSocket extends EventTarget {
  constructor(url, protocols) {
    super();
    this.url = String(url);
    this.protocol = "";
    this.extensions = "";
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.readyState = NativeWebSocket.CONNECTING;
    this.#protocols = protocols;

    const legacyJoin = parseLegacyJoinURL(url);
    if (!legacyJoin) {
      this.#attachSocket(new NativeWebSocket(url, protocols));
      return;
    }

    this.#connectWithToken(legacyJoin);
  }

  #protocols;
  #socket = null;
  #queue = [];
  #closedBeforeConnect = false;
  #closeCode;
  #closeReason;

  send(data) {
    if (this.#socket && this.#socket.readyState === NativeWebSocket.OPEN) {
      this.#socket.send(data);
      this.bufferedAmount = this.#socket.bufferedAmount;
      return;
    }

    if (this.readyState === NativeWebSocket.CONNECTING) {
      this.#queue.push(data);
      return;
    }

    throw new DOMException("WebSocket is not open", "InvalidStateError");
  }

  close(code, reason) {
    this.#closedBeforeConnect = true;
    this.#closeCode = code;
    this.#closeReason = reason;

    if (this.#socket) {
      this.readyState = this.#socket.readyState;
      this.#socket.close(code, reason);
      return;
    }

    if (this.readyState === NativeWebSocket.CLOSED) return;
    this.readyState = NativeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = NativeWebSocket.CLOSED;
      this.#emitClose(1000, reason || "closed before token join");
    });
  }

  async #connectWithToken(join) {
    try {
      const response = await fetch(`${apiBaseURL()}/api/rooms/${encodeURIComponent(join.roomID)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: join.nickname,
          pin: join.pin,
          avatar: join.avatar,
          clientId: join.clientID,
          creatorToken: join.creatorToken || ""
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(errorMessageForJoinFailure(response.status, body));
      }

      const contract = await response.json();
      if (!contract.wsUrl) throw new Error("El backend no devolvió URL WebSocket tokenizada.");

      persistJoinContract(join.roomID, contract);
      this.url = contract.wsUrl;
      const socket = new NativeWebSocket(contract.wsUrl, this.#protocols);
      this.#attachSocket(socket);

      if (this.#closedBeforeConnect) {
        socket.close(this.#closeCode, this.#closeReason);
      }
    } catch (error) {
      bridgeStatus(error.message || "No se pudo validar la entrada a la sala.");
      restoreJoinUI();
      this.#failBeforeSocket();
    }
  }

  #attachSocket(socket) {
    this.#socket = socket;
    this.readyState = socket.readyState;
    this.binaryType = socket.binaryType;

    socket.addEventListener("open", event => {
      this.readyState = socket.readyState;
      this.protocol = socket.protocol;
      this.extensions = socket.extensions;
      this.binaryType = socket.binaryType;
      for (const item of this.#queue.splice(0)) socket.send(item);
      this.#emitEvent(new Event(event.type));
    });

    socket.addEventListener("message", event => {
      this.readyState = socket.readyState;
      this.#emitEvent(new MessageEvent("message", { data: event.data, origin: event.origin }));
    });

    socket.addEventListener("error", () => {
      this.readyState = socket.readyState;
      this.#emitEvent(new Event("error"));
    });

    socket.addEventListener("close", event => {
      this.readyState = socket.readyState;
      this.#emitClose(event.code, event.reason, event.wasClean);
    });
  }

  #failBeforeSocket() {
    this.readyState = NativeWebSocket.CLOSED;
    this.#emitEvent(new Event("error"));
    this.#emitClose(4401, "join contract failed");
  }

  #emitClose(code, reason, wasClean = false) {
    let event;
    try {
      event = new CloseEvent("close", { code, reason, wasClean });
    } catch {
      event = new Event("close");
      event.code = code;
      event.reason = reason;
      event.wasClean = wasClean;
    }
    this.#emitEvent(event);
  }

  #emitEvent(event) {
    this.dispatchEvent(event);
    const handler = this[`on${event.type}`];
    if (typeof handler === "function") handler.call(this, event);
  }
}

if (NativeWebSocket && !NativeWebSocket.__lastSeenTokenBridge) {
  TokenBridgeWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  TokenBridgeWebSocket.OPEN = NativeWebSocket.OPEN;
  TokenBridgeWebSocket.CLOSING = NativeWebSocket.CLOSING;
  TokenBridgeWebSocket.CLOSED = NativeWebSocket.CLOSED;
  TokenBridgeWebSocket.__lastSeenTokenBridge = true;
  TokenBridgeWebSocket.NativeWebSocket = NativeWebSocket;
  globalThis.WebSocket = TokenBridgeWebSocket;
}
