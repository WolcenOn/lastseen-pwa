const statusEl = document.querySelector("#status");
const createRoomButton = document.querySelector("#create-room");
const randomRoomNameButton = document.querySelector("#random-room-name");
const roomNameInput = document.querySelector("#room-name-input");
const joinRoomButton = document.querySelector("#join-room");
const nicknameInput = document.querySelector("#nickname");
const pinInput = document.querySelector("#pin");
const randomPinButton = document.querySelector("#random-pin");
const avatarPicker = document.querySelector("#avatar-picker");
const copyLinkButton = document.querySelector("#copy-link");
const shareLinkButton = document.querySelector("#share-link");
const leaveRoomButton = document.querySelector("#leave-room");
const roomTitle = document.querySelector("#room-title");
const roomNameLabel = document.querySelector("#room-name");
const roomLink = document.querySelector("#room-link");
const joinCard = document.querySelector("#join-card");
const roomCard = document.querySelector("#room-card");
const roomStatus = document.querySelector("#room-status");
const membersEl = document.querySelector("#members");

const avatars = ["🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🐝", "🦄", "🐙", "🐢", "🐳", "⭐", "⚡"];
const adjectives = ["Luna", "Brava", "Azul", "Fugaz", "Clara", "Norte", "Libre", "Chispa", "Aurora", "Rayo", "Menta", "Nube"];
const nouns = ["Cuadrilla", "Cometa", "Farol", "Brújula", "Verbena", "Peña", "Ronda", "Refugio", "Mapa", "Equipo", "Punto", "Nido"];

const members = new Map();
let socket = null;
let watchId = null;
let batteryLevel = 0;
let selectedAvatar = avatars[0];
let myPIN = "";

registerServiceWorker();
initHome();
initRoom();

function initHome() {
  if (randomRoomNameButton) {
    randomRoomNameButton.addEventListener("click", () => {
      roomNameInput.value = randomRoomName();
    });
  }

  if (createRoomButton) {
    createRoomButton.addEventListener("click", createRoom);
  }
}

function initRoom() {
  const roomID = getRoomID();
  if (!roomID) return;

  hydrateRoomHeader(roomID);
  renderAvatarPicker();
  restoreIdentity(roomID);

  if (randomPinButton) {
    randomPinButton.addEventListener("click", () => {
      pinInput.value = generatePIN();
    });
  }

  if (joinRoomButton) {
    joinRoomButton.addEventListener("click", joinRoom);
  }

  if (copyLinkButton) {
    copyLinkButton.addEventListener("click", copyRoomLink);
  }

  if (shareLinkButton) {
    shareLinkButton.addEventListener("click", shareRoomLink);
  }

  if (leaveRoomButton) {
    leaveRoomButton.addEventListener("click", forceSelfDisconnect);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const swURL = new URL("./sw.js", document.baseURI);
    await navigator.serviceWorker.register(swURL);
  } catch (error) {
    console.warn("Service Worker registration failed", error);
  }
}

async function createRoom() {
  setStatus("Creando sala efímera…");
  createRoomButton.disabled = true;

  try {
    const response = await fetch(apiURL("/api/rooms"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: roomNameInput?.value?.trim() || "" })
    });
    if (!response.ok) throw new Error("No se pudo crear la sala");

    const data = await response.json();
    const roomID = data.roomId || extractRoomID(data.url);
    if (!roomID) throw new Error("La respuesta del servidor no contiene sala válida");

    window.location.href = buildRoomPageURL(roomID);
  } catch (error) {
    createRoomButton.disabled = false;
    setStatus(error.message || "Error creando sala");
  }
}

async function hydrateRoomHeader(roomID) {
  const absoluteURL = getAbsoluteRoomURL();
  if (roomLink) roomLink.value = absoluteURL;

  try {
    const response = await fetch(apiURL(`/api/rooms/${encodeURIComponent(roomID)}`));
    if (!response.ok) throw new Error("Sala no encontrada");

    const room = await response.json();
    const name = room.name || "Sala LastSeen";
    if (roomTitle) roomTitle.textContent = name;
    if (roomNameLabel) roomNameLabel.textContent = name;
    document.title = `${name} | LastSeen`;
  } catch (error) {
    if (roomTitle) roomTitle.textContent = "Sala LastSeen";
    setStatus(error.message || "No se pudo cargar la sala.");
  }
}

async function joinRoom() {
  const nickname = nicknameInput.value.trim();
  const pin = pinInput.value.trim();

  if (!nickname) {
    setStatus("Introduce un mote temporal.");
    return;
  }

  if (!/^\d{4,8}$/.test(pin)) {
    setStatus("El PIN debe tener entre 4 y 8 números.");
    return;
  }

  const roomID = getRoomID();
  if (!roomID) {
    setStatus("URL de sala no válida.");
    return;
  }

  joinRoomButton.disabled = true;
  setStatus("Solicitando permisos de ubicación…");

  batteryLevel = await readBatteryLevel();
  myPIN = pin;
  persistIdentity(roomID, nickname, pin, selectedAvatar);

  try {
    const position = await getCurrentPosition();
    connectSocket(roomID, nickname, pin, selectedAvatar, position);
    startLocationWatch();

    joinCard.hidden = true;
    roomCard.hidden = false;
  } catch (error) {
    joinRoomButton.disabled = false;
    setStatus(error.message || "No se pudo acceder al GPS.");
  }
}

function connectSocket(roomID, nickname, pin, avatar, initialPosition) {
  const params = new URLSearchParams({ nick: nickname, pin, avatar });
  const wsURL = wsURLFor(`/ws/rooms/${encodeURIComponent(roomID)}?${params}`);

  socket = new WebSocket(wsURL);

  socket.addEventListener("open", () => {
    setRoomStatus("Conectado. Compartiendo ubicación en tiempo real.");
    sendLocation(initialPosition);
  });

  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  });

  socket.addEventListener("close", () => {
    setRoomStatus("Desconectado. Reabre la sala o recupera cobertura para reconectar.");
    stopLocationWatch();
  });

  socket.addEventListener("error", () => {
    setRoomStatus("Error de conexión WebSocket.");
  });
}

function handleServerMessage(msg) {
  if (msg.t === "snapshot") {
    if (msg.d?.room?.name && roomTitle) {
      roomTitle.textContent = msg.d.room.name;
    }

    if (Array.isArray(msg.d?.clients)) {
      msg.d.clients.forEach(member => members.set(member.id, member));
      renderMembers();
    }
    return;
  }

  if (["join", "loc", "leave", "sos"].includes(msg.t) && msg.d?.id) {
    const previous = members.get(msg.d.id) || {};
    members.set(msg.d.id, { ...previous, ...msg.d });
    renderMembers();
    return;
  }

  if (msg.t === "wake") {
    tryWakeDevice();
  }

  if (msg.t === "panic") {
    setRoomStatus("Alerta de pánico recibida en la sala.");
  }
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    setRoomStatus("Este navegador no soporta geolocalización.");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    position => sendLocation(position),
    error => setRoomStatus(error.message || "No se pudo actualizar la ubicación."),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

function stopLocationWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function sendLocation(position) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({
    t: batteryLevel > 0 && batteryLevel <= 0.02 ? "sos" : "loc",
    lat: roundCoord(position.coords.latitude),
    lng: roundCoord(position.coords.longitude),
    bat: batteryLevel
  }));
}

function forceSelfDisconnect() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setRoomStatus("No hay una conexión activa que cerrar.");
    return;
  }

  const pin = window.prompt("Introduce tu PIN para cerrar tu conexión:");
  if (!pin) return;

  if (pin !== myPIN) {
    setRoomStatus("PIN incorrecto. No se ha cerrado la conexión.");
    return;
  }

  socket.send(JSON.stringify({ t: "disconnect", pin }));
  socket.close();
  stopLocationWatch();
  setRoomStatus("Conexión cerrada de forma forzada.");
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Este navegador no soporta geolocalización."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 12000
    });
  });
}

async function readBatteryLevel() {
  if (!("getBattery" in navigator)) return 0;

  try {
    const battery = await navigator.getBattery();
    return Number(battery.level || 0);
  } catch {
    return 0;
  }
}

function tryWakeDevice() {
  if ("vibrate" in navigator) {
    navigator.vibrate([700, 250, 700, 250, 1200]);
  }

  setRoomStatus("Comando despertar recibido.");
}

function renderMembers() {
  if (!membersEl) return;

  membersEl.innerHTML = "";

  for (const member of members.values()) {
    const row = document.createElement("div");
    row.className = "member";

    const lastSeen = member.seen ? new Date(member.seen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    const coords = member.lat && member.lng ? `${member.lat}, ${member.lng}` : "Sin ubicación todavía";
    const battery = member.bat ? ` · batería ${Math.round(member.bat * 100)}%` : "";

    row.innerHTML = `
      <div class="avatar" aria-hidden="true">${escapeHTML(member.avatar || "•")}</div>
      <div class="member-main">
        <strong>${escapeHTML(member.nick || "Sin mote")}</strong><br />
        <small>${coords}<br />Última señal: ${lastSeen}${battery}</small>
      </div>
      <span class="badge ${member.on ? "" : "offline"}">${member.on ? "online" : "last seen"}</span>
    `;

    membersEl.appendChild(row);
  }
}

function renderAvatarPicker() {
  if (!avatarPicker) return;

  avatarPicker.innerHTML = "";

  avatars.forEach((avatar, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `avatar-choice ${index === 0 ? "selected" : ""}`;
    button.textContent = avatar;
    button.setAttribute("aria-label", `Avatar ${avatar}`);

    button.addEventListener("click", () => {
      selectedAvatar = avatar;
      document.querySelectorAll(".avatar-choice").forEach(item => item.classList.remove("selected"));
      button.classList.add("selected");
    });

    avatarPicker.appendChild(button);
  });
}

function restoreIdentity(roomID) {
  const saved = readJSON(`lastseen:${roomID}:identity`);

  if (nicknameInput && saved?.nickname) nicknameInput.value = saved.nickname;
  if (pinInput) pinInput.value = saved?.pin || generatePIN();

  if (saved?.avatar && avatars.includes(saved.avatar)) {
    selectedAvatar = saved.avatar;
    queueMicrotask(() => {
      document.querySelectorAll(".avatar-choice").forEach(item => {
        item.classList.toggle("selected", item.textContent === selectedAvatar);
      });
    });
  }
}

function persistIdentity(roomID, nickname, pin, avatar) {
  localStorage.setItem(`lastseen:${roomID}:identity`, JSON.stringify({ nickname, pin, avatar }));
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

async function copyRoomLink() {
  const url = getAbsoluteRoomURL();

  try {
    await navigator.clipboard.writeText(url);
    setStatus("Enlace copiado al portapapeles.");
  } catch {
    setStatus(url);
  }
}

async function shareRoomLink() {
  const url = getAbsoluteRoomURL();
  const title = roomTitle?.textContent || "Sala LastSeen";

  if (navigator.share) {
    try {
      await navigator.share({ title, text: "Únete a mi sala LastSeen", url });
      return;
    } catch {
      // User cancelled or platform blocked share. Fall back to clipboard.
    }
  }

  await copyRoomLink();
}

function apiBaseURL() {
  const configured = String(window.LASTSEEN_API_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return window.location.origin;
}

function apiURL(path) {
  return `${apiBaseURL()}${path}`;
}

function wsURLFor(pathAndQuery) {
  const base = new URL(apiBaseURL());
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return `${base.origin}${pathAndQuery}`;
}

function getRoomID() {
  const params = new URLSearchParams(window.location.search);
  const queryRoomID = params.get("r") || params.get("room");
  if (queryRoomID) return queryRoomID;

  const match = window.location.pathname.match(/\/room\/([^/]+)$/);
  return match?.[1] || "";
}

function extractRoomID(pathOrURL) {
  if (!pathOrURL) return "";
  const match = String(pathOrURL).match(/\/room\/([^/?#]+)/);
  return match?.[1] || "";
}

function buildRoomPageURL(roomID) {
  return new URL(`./room.html?r=${encodeURIComponent(roomID)}`, document.baseURI).toString();
}

function getAbsoluteRoomURL() {
  const roomID = getRoomID();
  return buildRoomPageURL(roomID);
}

function randomRoomName() {
  const left = adjectives[Math.floor(Math.random() * adjectives.length)];
  const right = nouns[Math.floor(Math.random() * nouns.length)];
  return `${left} ${right}`;
}

function generatePIN() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function roundCoord(value) {
  return Math.round(value * 1000000) / 1000000;
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function setRoomStatus(message) {
  if (roomStatus) roomStatus.textContent = message;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#039;",
    '"': "&quot;"
  }[char]));
}
