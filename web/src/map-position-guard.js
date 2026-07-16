const capturedMaps = [];
let localMarker = null;
let localPosition = null;

installLeafletMapCapture();
installGeolocationCapture();
installWebSocketDiagnostics();

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
    socket.addEventListener("close", event => {
      const status = document.querySelector("#room-status") || document.querySelector("#status");
      if (!status) return;
      const suffix = event.code ? ` Código WS: ${event.code}${event.reason ? ` · ${event.reason}` : ""}.` : "";
      status.textContent = `Desconectado del servidor.${suffix}`;
    });
    socket.addEventListener("error", () => {
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

function renderLocalPosition(position) {
  if (!position?.coords) return;

  localPosition = position;
  const map = window.__lastSeenMap || capturedMaps[capturedMaps.length - 1];
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

function readRoomState() {
  const roomID = getRoomID();
  if (!roomID) return {};
  try {
    return JSON.parse(localStorage.getItem(`lastseen:${roomID}:state`) || "{}") || {};
  } catch {
    return {};
  }
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

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#039;",
    '"': "&quot;"
  }[char]));
}
