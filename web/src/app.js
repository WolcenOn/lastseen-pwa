const statusEl = document.querySelector("#status");
const createRoomButton = document.querySelector("#create-room");
const joinRoomButton = document.querySelector("#join-room");
const nicknameInput = document.querySelector("#nickname");
const joinCard = document.querySelector("#join-card");
const roomCard = document.querySelector("#room-card");
const roomStatus = document.querySelector("#room-status");
const membersEl = document.querySelector("#members");

const members = new Map();
let socket = null;
let watchId = null;
let batteryLevel = 0;

registerServiceWorker();

if (createRoomButton) {
  createRoomButton.addEventListener("click", createRoom);
}

if (joinRoomButton) {
  joinRoomButton.addEventListener("click", joinRoom);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (error) {
    console.warn("Service Worker registration failed", error);
  }
}

async function createRoom() {
  setStatus("Creando sala efímera…");

  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    if (!response.ok) throw new Error("No se pudo crear la sala");

    const data = await response.json();
    window.location.href = data.url;
  } catch (error) {
    setStatus(error.message || "Error creando sala");
  }
}

async function joinRoom() {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    setStatus("Introduce un mote temporal.");
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

  try {
    const position = await getCurrentPosition();
    connectSocket(roomID, nickname, position);
    startLocationWatch();

    joinCard.hidden = true;
    roomCard.hidden = false;
  } catch (error) {
    joinRoomButton.disabled = false;
    setStatus(error.message || "No se pudo acceder al GPS.");
  }
}

function connectSocket(roomID, nickname, initialPosition) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsURL = `${protocol}://${window.location.host}/ws/rooms/${encodeURIComponent(roomID)}?nick=${encodeURIComponent(nickname)}`;

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
  if (msg.t === "snapshot" && Array.isArray(msg.d)) {
    msg.d.forEach(member => members.set(member.id, member));
    renderMembers();
    return;
  }

  if (["join", "loc", "leave", "sos"].includes(msg.t) && msg.d?.id) {
    members.set(msg.d.id, msg.d);
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

    row.innerHTML = `
      <div>
        <strong>${escapeHTML(member.nick)}</strong><br />
        <small>${coords}<br />Última señal: ${lastSeen}</small>
      </div>
      <span class="badge ${member.on ? "" : "offline"}">${member.on ? "online" : "last seen"}</span>
    `;

    membersEl.appendChild(row);
  }
}

function getRoomID() {
  const match = window.location.pathname.match(/^\/room\/([^/]+)$/);
  return match?.[1] || "";
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
