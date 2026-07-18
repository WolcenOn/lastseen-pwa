const capturedMaps = [];
let localMarker = null;
let localPosition = null;
let activeSocket = null;
let pendingSafetyAction = "";
let safetyMeetingMarker = null;
let safetyPerimeterCircle = null;
let markerSpreadCounter = 0;

installLeafletMarkerSpread();
installLeafletMapCapture();
installGeolocationCapture();
installWebSocketDiagnostics();
installRoomEndHandler();
installSafetyControls();

function installLeafletMarkerSpread() {
  if (!window.L || typeof window.L.marker !== "function" || window.L.__lastSeenMarkerSpreadInstalled) return;
  window.L.__lastSeenMarkerSpreadInstalled = true;

  const nativeMarker = window.L.marker.bind(window.L);
  window.L.marker = (latLng, options = {}) => {
    const isMemberMarker = String(options?.icon?.options?.html || "").includes("member-marker");
    const marker = nativeMarker(isMemberMarker ? spreadLatLng(latLng, markerSpreadCounter) : latLng, options);

    if (isMemberMarker) {
      marker.__lastSeenSpreadIndex = markerSpreadCounter;
      markerSpreadCounter += 1;
      const nativeSetLatLng = marker.setLatLng.bind(marker);
      marker.setLatLng = nextLatLng => nativeSetLatLng(spreadLatLng(nextLatLng, marker.__lastSeenSpreadIndex));
    }

    return marker;
  };
}

function spreadLatLng(latLng, index) {
  const point = Array.isArray(latLng) ? { lat: Number(latLng[0]), lng: Number(latLng[1]) } : { lat: Number(latLng?.lat), lng: Number(latLng?.lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return latLng;

  const ring = Math.floor(index / 8);
  const slot = index % 8;
  const radiusMeters = ring === 0 ? 0 : 7 + ring * 4;
  if (radiusMeters === 0) return [point.lat, point.lng];

  const angle = (Math.PI * 2 * slot) / 8;
  const latOffset = (Math.sin(angle) * radiusMeters) / 111320;
  const lngOffset = (Math.cos(angle) * radiusMeters) / (111320 * Math.cos(point.lat * Math.PI / 180));
  return [roundCoord(point.lat + latOffset), roundCoord(point.lng + lngOffset)];
}

function installLeafletMapCapture() {
  if (!window.L || typeof window.L.map !== "function") return;
  if (window.__lastSeenMapGuardInstalled) return;
  window.__lastSeenMapGuardInstalled = true;

  const originalMap = window.L.map.bind(window.L);
  window.L.map = (...args) => {
    const map = originalMap(...args);
    capturedMaps.push(map);
    window.__lastSeenMap = map;
    stabilizeMapLayout(map);
    installSafetyMapClick(map);
    if (localPosition) renderLocalPosition(localPosition);
    return map;
  };
}

function installGeolocationCapture() {
  if (!navigator.geolocation || navigator.geolocation.__lastSeenPatched) return;
  navigator.geolocation.__lastSeenPatched = true;

  const originalGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
  const originalWatchPosition = navigator.geolocation.watchPosition.bind(navigator.geolocation);

  navigator.geolocation.getCurrentPosition = (success, error, options) => originalGetCurrentPosition(
    position => {
      renderLocalPosition(position);
      success?.(position);
    },
    error,
    options
  );

  navigator.geolocation.watchPosition = (success, error, options) => originalWatchPosition(
    position => {
      renderLocalPosition(position);
      success?.(position);
    },
    error,
    options
  );
}

function installWebSocketDiagnostics() {
  if (!window.WebSocket || window.WebSocket.__lastSeenPatched) return;
  const NativeWebSocket = window.WebSocket;

  function PatchedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    activeSocket = socket;
    window.__lastSeenSocket = socket;

    socket.addEventListener("message", event => {
      const msg = safeJSON(event.data);
      if (msg?.t === "meet" && msg.d) renderSafetyMeetingPoint(msg.d);
      if (msg?.t === "perimeter" && msg.d) renderSafetyPerimeter(msg.d);
      if (msg?.t !== "error") return;

      const code = msg.d?.code || "join_failed";
      const status = document.querySelector("#room-status") || document.querySelector("#status");
      if (code === "nickname_taken") {
        if (status) status.textContent = msg.d?.message || "Ese mote ya está en uso. Elige otro.";
        showJoinCardAgain();
        return;
      }
      if (status) status.textContent = msg.d?.message || "No se pudo entrar en la sala.";
    });
    socket.addEventListener("close", event => {
      if (activeSocket === socket) activeSocket = null;
      if (window.__lastSeenSocket === socket) window.__lastSeenSocket = null;
      if (window.__lastSeenExpectedSocketClose || window.__lastSeenRoomEnding) return;
      const status = document.querySelector("#room-status") || document.querySelector("#status");
      if (!status) return;
      const suffix = event.code ? ` Código WS: ${event.code}${event.reason ? ` · ${event.reason}` : ""}.` : "";
      status.textContent = `Desconectado del servidor.${suffix}`;
    });
    socket.addEventListener("error", () => {
      if (window.__lastSeenExpectedSocketClose || window.__lastSeenRoomEnding) return;
      const status = document.querySelector("#room-status") || document.querySelector("#status");
      if (status) status.textContent = "Error de conexión WebSocket. Revisa permisos de origen o cobertura.";
    });
    return socket;
  }

  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  PatchedWebSocket.OPEN = NativeWebSocket.OPEN;
  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  PatchedWebSocket.__lastSeenPatched = true;
  window.WebSocket = PatchedWebSocket;
}

function installRoomEndHandler() {
  document.addEventListener("click", async event => {
    const button = event.target?.closest?.("#end-room");
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (!window.confirm("¿Terminar esta sala para todos?")) return;

    const roomID = getRoomID();
    const state = readRoomState();
    const token = state.creatorToken || readCreatorTokenBackup(roomID);
    const status = document.querySelector("#creator-status") || document.querySelector("#room-status");

    if (!token) {
      if (status) status.textContent = "Este dispositivo no tiene token de creador.";
      return;
    }

    button.disabled = true;
    window.__lastSeenRoomEnding = true;
    window.__lastSeenExpectedSocketClose = true;
    if (status) status.textContent = "Terminando sala…";

    try {
      const response = await fetch(apiURL(`/api/rooms/${encodeURIComponent(roomID)}`), {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Creator-Token": token }
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`No se pudo terminar la sala (${response.status}). ${text}`.trim());
      }

      markRoomEnded(roomID);
      if (status) status.textContent = "Sala terminada. Volviendo al inicio…";
      setTimeout(() => {
        window.location.href = new URL("./", document.baseURI).toString();
      }, 600);
    } catch (error) {
      window.__lastSeenRoomEnding = false;
      window.__lastSeenExpectedSocketClose = false;
      button.disabled = false;
      if (status) status.textContent = error.message || "Error terminando sala.";
    }
  }, { capture: true });
}

function installSafetyControls() {
  document.addEventListener("click", event => {
    const meetingHere = event.target?.closest?.("#set-meeting-here");
    const meetingMap = event.target?.closest?.("#set-meeting-map");
    const perimeterMap = event.target?.closest?.("#set-perimeter-map");

    if (!meetingHere && !meetingMap && !perimeterMap) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (meetingHere) {
      const coords = localCoords();
      if (!coords) return setSafetyStatus("Aún no tengo tu ubicación para fijar el punto aquí.");
      sendSafetyMessage("meet", coords.lat, coords.lng);
      renderSafetyMeetingPoint({ lat: coords.lat, lng: coords.lng });
      setSafetyStatus("Punto de encuentro fijado en tu ubicación actual.");
      return;
    }

    const map = currentMap();
    if (!map) return setSafetyStatus("Abre el mapa antes de fijar puntos de seguridad.");
    pendingSafetyAction = meetingMap ? "meet" : "perimeter";
    stabilizeMapLayout(map);
    setSafetyStatus(pendingSafetyAction === "meet" ? "Toca el mapa para fijar el punto de encuentro." : "Toca el mapa para centrar el perímetro.");
  }, { capture: true });
}

function installSafetyMapClick(map) {
  if (!map || map.__lastSeenSafetyClickInstalled) return;
  map.__lastSeenSafetyClickInstalled = true;

  map.on("click", event => {
    if (!pendingSafetyAction) return;
    const lat = roundCoord(event.latlng.lat);
    const lng = roundCoord(event.latlng.lng);

    if (pendingSafetyAction === "meet") {
      sendSafetyMessage("meet", lat, lng);
      renderSafetyMeetingPoint({ lat, lng });
      setSafetyStatus("Punto de encuentro enviado a la sala.");
    }

    if (pendingSafetyAction === "perimeter") {
      const radius = selectedPerimeterRadius();
      sendSafetyMessage("perimeter", lat, lng, radius);
      renderSafetyPerimeter({ lat, lng, radius });
      setSafetyStatus(`Perímetro enviado a la sala: ${radius} m.`);
    }

    pendingSafetyAction = "";
  });
}

function sendSafetyMessage(type, lat, lng, radius) {
  const socket = activeSocket || window.__lastSeenSocket;
  if (!socket || socket.readyState !== window.WebSocket.OPEN) {
    setSafetyStatus("Conecta con la sala antes de fijar puntos de seguridad.");
    return false;
  }

  const payload = { t: type, lat: roundCoord(lat), lng: roundCoord(lng) };
  if (type === "perimeter") payload.radius = radius;
  socket.send(JSON.stringify(payload));
  return true;
}

function renderLocalPosition(position) {
  if (!position?.coords) return;

  localPosition = position;
  const map = currentMap();
  const state = readRoomState();
  const lat = roundCoord(position.coords.latitude);
  const lng = roundCoord(position.coords.longitude);
  const member = {
    id: state.clientId || "local-self",
    nick: state.nickname || "Tú",
    avatar: state.avatar || "📍",
    lat,
    lng,
    on: true,
    seen: new Date().toISOString()
  };

  renderLocalMemberRow(member);

  if (!map || !window.L) return;
  stabilizeMapLayout(map);

  const latLng = [lat, lng];
  const icon = window.L.divIcon({
    className: "",
    html: `<div class="member-marker local-self"><span class="member-marker-avatar">${escapeHTML(member.avatar)}</span><span class="member-marker-label">${escapeHTML(shortName(member.nick))}</span></div>`,
    iconSize: [120, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -20]
  });

  if (localMarker) {
    localMarker.setLatLng(latLng);
    localMarker.setIcon(icon);
    localMarker.setPopupContent("Tu posición local");
  } else {
    localMarker = window.L.marker(latLng, { icon }).addTo(map).bindPopup("Tu posición local");
  }

  if (!map.__lastSeenCentered) {
    map.__lastSeenCentered = true;
    setTimeout(() => {
      map.setView(latLng, Math.max(map.getZoom() || 16, 16), { animate: false });
      map.invalidateSize();
    }, 120);
  }
}

function renderSafetyMeetingPoint(point) {
  const map = currentMap();
  if (!map || !window.L || !validLatLng(point)) return;
  const latLng = [Number(point.lat), Number(point.lng)];
  const icon = window.L.divIcon({ className: "", html: '<div class="meeting-marker">📍</div>', iconSize: [42, 42], iconAnchor: [21, 36], popupAnchor: [0, -34] });
  if (safetyMeetingMarker) safetyMeetingMarker.setLatLng(latLng);
  else safetyMeetingMarker = window.L.marker(latLng, { icon }).addTo(map);
  safetyMeetingMarker.bindPopup("Punto de encuentro");
}

function renderSafetyPerimeter(perimeter) {
  const map = currentMap();
  if (!map || !window.L || !validLatLng(perimeter)) return;
  const radius = Number(perimeter.radius || perimeter.radiusMeters || selectedPerimeterRadius());
  const latLng = [Number(perimeter.lat), Number(perimeter.lng)];

  if (safetyPerimeterCircle) {
    safetyPerimeterCircle.setLatLng(latLng);
    safetyPerimeterCircle.setRadius(radius);
  } else {
    safetyPerimeterCircle = window.L.circle(latLng, { radius, weight: 2, fillOpacity: 0.08 }).addTo(map);
  }
  safetyPerimeterCircle.bindPopup(`Perímetro: ${radius} m`);
}

function showJoinCardAgain() {
  const joinCard = document.querySelector("#join-card");
  const roomCard = document.querySelector("#room-card");
  const joinButton = document.querySelector("#join-room");
  if (joinCard) joinCard.hidden = false;
  if (roomCard) roomCard.hidden = true;
  if (joinButton) joinButton.disabled = false;
}

function renderLocalMemberRow(member) {
  const target = document.querySelector("#members");
  if (!target) return;

  const existingHint = target.querySelector(".hint");
  if (existingHint && /Sin miembros/.test(existingHint.textContent || "")) existingHint.remove();

  let row = target.querySelector('[data-local-self="1"]');
  if (!row) {
    row = document.createElement("div");
    row.className = "member local-self";
    row.dataset.localSelf = "1";
    target.prepend(row);
  }

  row.innerHTML = `
    <div class="avatar" aria-hidden="true">${escapeHTML(member.avatar || "📍")}</div>
    <div class="member-main">
      <strong>${escapeHTML(member.nick || "Tú")}</strong><br />
      <small>${member.lat}, ${member.lng}<br />Última señal local: ahora</small>
    </div>
    <span class="badge">online</span>`;
}

function stabilizeMapLayout(map) {
  [50, 150, 350, 800].forEach(delay => setTimeout(() => map.invalidateSize(), delay));
}

function currentMap() {
  return window.__lastSeenMap || capturedMaps[capturedMaps.length - 1] || null;
}

function localCoords() {
  if (!localPosition?.coords) return null;
  return {
    lat: roundCoord(localPosition.coords.latitude),
    lng: roundCoord(localPosition.coords.longitude)
  };
}

function selectedPerimeterRadius() {
  const value = Number(document.querySelector("#perimeter-radius")?.value || 250);
  return Number.isFinite(value) ? Math.max(50, Math.min(5000, value)) : 250;
}

function setSafetyStatus(message) {
  const status = document.querySelector("#safety-status") || document.querySelector("#room-status") || document.querySelector("#status");
  if (status) status.textContent = message;
}

function validLatLng(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function markRoomEnded(roomID) {
  const state = readRoomState();
  state.active = false;
  state.endedAt = new Date().toISOString();
  state.serverRoom = { ...(state.serverRoom || {}), closed: true };
  localStorage.setItem(`lastseen:${roomID}:state`, JSON.stringify(state));
}

function readRoomState() {
  const roomID = getRoomID();
  if (!roomID) return {};
  try {
    return JSON.parse(localStorage.getItem(`lastseen:${roomID}:state`) || "{}") || {};
  } catch {
    return {};
  }
}

function readCreatorTokenBackup(roomID) {
  if (!roomID) return "";
  try {
    return localStorage.getItem(`lastseen:${roomID}:creator-token`) || sessionStorage.getItem(`lastseen:${roomID}:creator-token`) || "";
  } catch {
    return localStorage.getItem(`lastseen:${roomID}:creator-token`) || "";
  }
}

function apiBaseURL() {
  const configured = String(window.LASTSEEN_API_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return window.location.origin;
}

function apiURL(path) {
  return `${apiBaseURL()}${path}`;
}

function getRoomID() {
  const params = new URLSearchParams(window.location.search);
  const queryRoomID = params.get("r") || params.get("room");
  if (queryRoomID) return queryRoomID;
  const match = window.location.pathname.match(/\/room\/([^/]+)$/);
  return match?.[1] || "";
}

function roundCoord(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function shortName(value) {
  const clean = String(value || "Tú").trim();
  return clean.length > 12 ? `${clean.slice(0, 11)}…` : clean;
}

function safeJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
