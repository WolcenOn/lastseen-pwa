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
const mapEl = document.querySelector("#map");
const fitMapButton = document.querySelector("#fit-map");
const setMeetingHereButton = document.querySelector("#set-meeting-here");
const setMeetingMapButton = document.querySelector("#set-meeting-map");
const setPerimeterMapButton = document.querySelector("#set-perimeter-map");
const perimeterRadiusInput = document.querySelector("#perimeter-radius");
const inactivityMinutesInput = document.querySelector("#inactivity-minutes");
const checkInactivityButton = document.querySelector("#check-inactivity");
const safetyStatus = document.querySelector("#safety-status");

const avatars = ["🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐧", "🦉", "🐝", "🦄", "🐙", "🐢", "🐳", "⭐", "⚡"];
const adjectives = ["Luna", "Brava", "Azul", "Fugaz", "Clara", "Norte", "Libre", "Chispa", "Aurora", "Rayo", "Menta", "Nube"];
const nouns = ["Cuadrilla", "Cometa", "Farol", "Brújula", "Verbena", "Peña", "Ronda", "Refugio", "Mapa", "Equipo", "Punto", "Nido"];
const DEFAULT_MAP_CENTER = [40.4168, -3.7038];

const members = new Map();
const memberMarkers = new Map();
let socket = null;
let watchId = null;
let batteryLevel = 0;
let selectedAvatar = avatars[0];
let myPIN = "";
let map = null;
let meetingMarker = null;
let perimeterCircle = null;
let pendingMapAction = "";
let lastOwnPosition = null;
let safety = { meetingPoint: null, perimeter: null };

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
  wireSafetyControls();

  if (randomPinButton) {
    randomPinButton.addEventListener("click", () => {
      pinInput.value = generatePIN();
    });
  }

  if (joinRoomButton) joinRoomButton.addEventListener("click", joinRoom);
  if (copyLinkButton) copyLinkButton.addEventListener("click", copyRoomLink);
  if (shareLinkButton) shareLinkButton.addEventListener("click", shareRoomLink);
  if (leaveRoomButton) leaveRoomButton.addEventListener("click", forceSelfDisconnect);
}

function wireSafetyControls() {
  if (fitMapButton) fitMapButton.addEventListener("click", fitMapToKnownPoints);

  if (setMeetingHereButton) {
    setMeetingHereButton.addEventListener("click", () => {
      if (!lastOwnPosition) {
        setSafetyStatus("Aún no tengo tu ubicación para fijar el punto aquí.");
        return;
      }
      sendMeetingPoint(lastOwnPosition.lat, lastOwnPosition.lng);
    });
  }

  if (setMeetingMapButton) {
    setMeetingMapButton.addEventListener("click", () => setPendingMapAction("meet"));
  }

  if (setPerimeterMapButton) {
    setPerimeterMapButton.addEventListener("click", () => setPendingMapAction("perimeter"));
  }

  if (checkInactivityButton) {
    checkInactivityButton.addEventListener("click", checkInactivity);
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
    applySafety(room.safety || {});
  } catch (error) {
    if (roomTitle) roomTitle.textContent = "Sala LastSeen";
    setStatus(error.message || "No se pudo cargar la sala.");
  }
}

async function joinRoom() {
  const nickname = nicknameInput.value.trim();
  const pin = pinInput.value.trim();

  if (!nickname) return setStatus("Introduce un mote temporal.");
  if (!/^\d{4,8}$/.test(pin)) return setStatus("El PIN debe tener entre 4 y 8 números.");

  const roomID = getRoomID();
  if (!roomID) return setStatus("URL de sala no válida.");

  joinRoomButton.disabled = true;
  setStatus("Solicitando permisos de ubicación…");

  batteryLevel = await readBatteryLevel();
  myPIN = pin;
  persistIdentity(roomID, nickname, pin, selectedAvatar);

  try {
    const position = await getCurrentPosition();
    joinCard.hidden = true;
    roomCard.hidden = false;
    initMap(position.coords.latitude, position.coords.longitude);
    connectSocket(roomID, nickname, pin, selectedAvatar, position);
    startLocationWatch();
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
    if (msg.d?.room?.name && roomTitle) roomTitle.textContent = msg.d.room.name;
    if (Array.isArray(msg.d?.clients)) {
      msg.d.clients.forEach(member => members.set(member.id, member));
      renderMembers();
      renderMapMarkers();
    }
    applySafety(msg.d?.safety || msg.d?.room?.safety || {});
    return;
  }

  if (["join", "loc", "leave", "sos"].includes(msg.t) && msg.d?.id) {
    const previous = members.get(msg.d.id) || {};
    members.set(msg.d.id, { ...previous, ...msg.d });
    renderMembers();
    renderMapMarkers();
    return;
  }

  if (msg.t === "meet") {
    applySafety({ ...safety, meetingPoint: msg.d });
    setSafetyStatus("Punto de encuentro actualizado para la sala.");
  }

  if (msg.t === "perimeter") {
    applySafety({ ...safety, perimeter: msg.d });
    setSafetyStatus(`Perímetro activado: ${msg.d.radius} m.`);
  }

  if (msg.t === "wake") tryWakeDevice();
  if (msg.t === "panic") setRoomStatus("Alerta de pánico recibida en la sala.");
}

function initMap(lat, lng) {
  if (!mapEl || map || typeof L === "undefined") return;

  map = L.map(mapEl, { zoomControl: true }).setView([lat || DEFAULT_MAP_CENTER[0], lng || DEFAULT_MAP_CENTER[1]], 16);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors"
  }).addTo(map);

  map.on("click", event => {
    if (pendingMapAction === "meet") {
      sendMeetingPoint(event.latlng.lat, event.latlng.lng);
      pendingMapAction = "";
      return;
    }

    if (pendingMapAction === "perimeter") {
      sendPerimeter(event.latlng.lat, event.latlng.lng, selectedPerimeterRadius());
      pendingMapAction = "";
    }
  });

  setTimeout(() => map.invalidateSize(), 150);
}

function renderMapMarkers() {
  if (!map || typeof L === "undefined") return;

  for (const member of members.values()) {
    if (!hasLatLng(member)) continue;

    const latLng = [member.lat, member.lng];
    const icon = L.divIcon({
      className: "",
      html: `<div class="member-marker ${member.on ? "" : "offline"} ${member.geo || member.sos ? "alert" : ""}">${escapeHTML(member.avatar || "•")}</div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20]
    });

    const popup = `<strong>${escapeHTML(member.nick || "Sin mote")}</strong><br>${member.on ? "online" : "last seen"}${member.geo ? "<br>Fuera del perímetro" : ""}`;
    const marker = memberMarkers.get(member.id);

    if (marker) {
      marker.setLatLng(latLng);
      marker.setIcon(icon);
      marker.setPopupContent(popup);
    } else {
      memberMarkers.set(member.id, L.marker(latLng, { icon }).addTo(map).bindPopup(popup));
    }
  }
}

function applySafety(nextSafety) {
  safety = {
    meetingPoint: nextSafety.meetingPoint || null,
    perimeter: nextSafety.perimeter || null
  };

  renderMeetingPoint();
  renderPerimeter();
}

function renderMeetingPoint() {
  if (!map || typeof L === "undefined") return;
  const point = safety.meetingPoint;

  if (!point) {
    if (meetingMarker) meetingMarker.remove();
    meetingMarker = null;
    return;
  }

  const icon = L.divIcon({
    className: "",
    html: `<div class="meeting-marker">📍</div>`,
    iconSize: [42, 42],
    iconAnchor: [21, 36],
    popupAnchor: [0, -34]
  });

  const latLng = [point.lat, point.lng];
  if (meetingMarker) {
    meetingMarker.setLatLng(latLng);
  } else {
    meetingMarker = L.marker(latLng, { icon }).addTo(map);
  }
  meetingMarker.bindPopup("Punto de encuentro");
}

function renderPerimeter() {
  if (!map || typeof L === "undefined") return;
  const perimeter = safety.perimeter;

  if (!perimeter) {
    if (perimeterCircle) perimeterCircle.remove();
    perimeterCircle = null;
    return;
  }

  const latLng = [perimeter.lat, perimeter.lng];
  const options = { radius: perimeter.radius, weight: 2, fillOpacity: 0.08 };
  if (perimeterCircle) {
    perimeterCircle.setLatLng(latLng);
    perimeterCircle.setRadius(perimeter.radius);
  } else {
    perimeterCircle = L.circle(latLng, options).addTo(map);
  }
  perimeterCircle.bindPopup(`Perímetro: ${perimeter.radius} m`);
}

function fitMapToKnownPoints() {
  if (!map || typeof L === "undefined") return;

  const points = [];
  for (const member of members.values()) {
    if (hasLatLng(member)) points.push([member.lat, member.lng]);
  }
  if (safety.meetingPoint) points.push([safety.meetingPoint.lat, safety.meetingPoint.lng]);
  if (safety.perimeter) points.push([safety.perimeter.lat, safety.perimeter.lng]);

  if (points.length === 0) return;
  map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 17 });
}

function setPendingMapAction(action) {
  pendingMapAction = action;
  setSafetyStatus(action === "meet" ? "Toca el mapa para fijar el punto de encuentro." : "Toca el mapa para centrar el perímetro.");
}

function sendMeetingPoint(lat, lng) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return setSafetyStatus("Conecta con la sala antes de fijar el punto.");
  socket.send(JSON.stringify({ t: "meet", lat: roundCoord(lat), lng: roundCoord(lng) }));
}

function sendPerimeter(lat, lng, radius) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return setSafetyStatus("Conecta con la sala antes de activar el perímetro.");
  socket.send(JSON.stringify({ t: "perimeter", lat: roundCoord(lat), lng: roundCoord(lng), radius }));
}

function selectedPerimeterRadius() {
  return Number(perimeterRadiusInput?.value || 250);
}

function checkInactivity() {
  const thresholdMinutes = Number(inactivityMinutesInput?.value || 5);
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const now = Date.now();
  const inactive = [...members.values()].filter(member => member.seen && now - new Date(member.seen).getTime() > thresholdMs);

  if (inactive.length === 0) {
    setSafetyStatus(`Sin inactividad superior a ${thresholdMinutes} min.`);
    return;
  }

  setSafetyStatus(`Inactividad: ${inactive.map(member => member.nick || "Sin mote").join(", ")}.`);
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

  lastOwnPosition = {
    lat: roundCoord(position.coords.latitude),
    lng: roundCoord(position.coords.longitude)
  };

  socket.send(JSON.stringify({
    t: batteryLevel > 0 && batteryLevel <= 0.02 ? "sos" : "loc",
    lat: lastOwnPosition.lat,
    lng: lastOwnPosition.lng,
    bat: batteryLevel
  }));
}

function forceSelfDisconnect() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return setRoomStatus("No hay una conexión activa que cerrar.");

  const pin = window.prompt("Introduce tu PIN para cerrar tu conexión:");
  if (!pin) return;

  if (pin !== myPIN) return setRoomStatus("PIN incorrecto. No se ha cerrado la conexión.");

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
  if ("vibrate" in navigator) navigator.vibrate([700, 250, 700, 250, 1200]);
  setRoomStatus("Comando despertar recibido.");
}

function renderMembers() {
  if (!membersEl) return;

  membersEl.innerHTML = "";

  for (const member of members.values()) {
    const row = document.createElement("div");
    row.className = `member ${member.geo ? "geo-alert" : ""}`;

    const lastSeen = member.seen ? new Date(member.seen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    const coords = hasLatLng(member) ? `${member.lat}, ${member.lng}` : "Sin ubicación todavía";
    const battery = member.bat ? ` · batería ${Math.round(member.bat * 100)}%` : "";
    const alert = member.geo ? "<br />⚠️ Fuera del perímetro" : member.sos ? "<br />🆘 SOS" : "";

    row.innerHTML = `
      <div class="avatar" aria-hidden="true">${escapeHTML(member.avatar || "•")}</div>
      <div class="member-main">
        <strong>${escapeHTML(member.nick || "Sin mote")}</strong><br />
        <small>${coords}<br />Última señal: ${lastSeen}${battery}${alert}</small>
      </div>
      <span class="badge ${member.geo || member.sos ? "alert" : member.on ? "" : "offline"}">${member.geo ? "perímetro" : member.on ? "online" : "last seen"}</span>
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

function hasLatLng(value) {
  return typeof value?.lat === "number" && typeof value?.lng === "number" && !(value.lat === 0 && value.lng === 0);
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

function setSafetyStatus(message) {
  if (safetyStatus) safetyStatus.textContent = message;
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
