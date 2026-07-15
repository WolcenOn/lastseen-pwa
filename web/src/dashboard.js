const dashboardEl = document.querySelector("#room-dashboard");
const refreshDashboardButton = document.querySelector("#refresh-room-dashboard");
const roomCardTemplate = document.querySelector("#room-card-template");
const createRoomButton = document.querySelector("#create-room");
const roomNameInput = document.querySelector("#room-name-input");
const statusEl = document.querySelector("#status");

const ROOM_KEY_PATTERN = /^lastseen:(.+):state$/;
const ROOM_INDEX_KEY = "lastseen:rooms";

if (dashboardEl) {
  createRoomButton?.addEventListener("click", createRoomFromDashboard, { capture: true });
  refreshDashboardButton?.addEventListener("click", renderRoomDashboard);
  renderRoomDashboard();
}

async function createRoomFromDashboard(event) {
  event.preventDefault();
  event.stopImmediatePropagation();

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

    const state = normalizeRoomState(roomID, readJSON(roomKey(roomID)) || {});
    state.roomId = roomID;
    state.roomName = data.name || state.roomName || "Sala LastSeen";
    state.isCreator = true;
    state.creatorToken = data.creatorToken || state.creatorToken || "";
    state.ttl = Number(data.ttl || state.ttl || 10800);
    state.clientId = state.clientId || generateClientID();
    state.createdAt = new Date().toISOString();
    state.lastJoinedAt = state.lastJoinedAt || state.createdAt;

    saveRoomState(roomID, state);
    await renderRoomDashboard();

    window.location.href = roomURL(roomID);
  } catch (error) {
    createRoomButton.disabled = false;
    setStatus(error.message || "Error creando sala");
  }
}

async function renderRoomDashboard() {
  const states = readSavedRoomStates();
  dashboardEl.innerHTML = "";

  if (states.length === 0) {
    dashboardEl.innerHTML = `
      <div class="empty-state">
        <strong>No hay salas guardadas todavía.</strong>
        <p class="hint">Cuando crees o entres en una sala, aparecerá aquí para reentrar o revisar el historial local.</p>
      </div>
    `;
    return;
  }

  refreshDashboardButton.disabled = true;
  try {
    const enriched = await Promise.all(states.map(enrichRoomState));
    enriched
      .sort(sortRoomsForDashboard)
      .forEach(room => dashboardEl.appendChild(renderSavedRoom(room)));
  } finally {
    refreshDashboardButton.disabled = false;
  }
}

function readSavedRoomStates() {
  const roomIDs = new Set(readRoomIndex());

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const match = key?.match(ROOM_KEY_PATTERN);
    if (match?.[1]) roomIDs.add(match[1]);
  }

  const rooms = [...roomIDs]
    .map(roomID => normalizeRoomState(roomID, readJSON(roomKey(roomID)) || {}))
    .filter(room => room.roomId);

  saveRoomIndex(rooms.map(room => room.roomId));
  return rooms;
}

function normalizeRoomState(roomID, state) {
  return {
    roomId: state.roomId || roomID,
    roomName: state.roomName || "Sala LastSeen",
    clientId: state.clientId || "",
    nickname: state.nickname || "",
    avatar: state.avatar || "",
    pin: state.pin || "",
    isCreator: Boolean(state.isCreator),
    creatorToken: state.creatorToken || "",
    ttl: Number(state.ttl || 0),
    createdAt: state.createdAt || "",
    lastJoinedAt: state.lastJoinedAt || "",
    membersHistory: state.membersHistory || {},
    safety: state.safety || {},
    localOnly: true,
    active: false,
    serverRoom: null
  };
}

async function enrichRoomState(room) {
  try {
    const response = await fetch(apiURL(`/api/rooms/${encodeURIComponent(room.roomId)}`), { cache: "no-store" });
    if (!response.ok) return room;

    const serverRoom = await response.json();
    const enriched = {
      ...room,
      active: true,
      localOnly: false,
      serverRoom,
      roomName: serverRoom.name || room.roomName,
      ttl: Number(serverRoom.ttl || room.ttl || 0),
      safety: serverRoom.safety || room.safety || {}
    };

    saveRoomState(room.roomId, enriched);
    return enriched;
  } catch {
    return room;
  }
}

function sortRoomsForDashboard(left, right) {
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (left.isCreator !== right.isCreator) return left.isCreator ? -1 : 1;
  return lastActivityTime(right) - lastActivityTime(left);
}

function lastActivityTime(room) {
  const historyTimes = Object.values(room.membersHistory || {})
    .map(member => Date.parse(member.archivedAt || member.seen || ""))
    .filter(Number.isFinite);
  const joined = Date.parse(room.lastJoinedAt || "");
  const created = Date.parse(room.createdAt || "");
  return Math.max(joined || 0, created || 0, ...historyTimes, 0);
}

function renderSavedRoom(room) {
  const node = roomCardTemplate.content.firstElementChild.cloneNode(true);
  const badge = node.querySelector(".room-state-badge");
  const title = node.querySelector(".saved-room-title");
  const meta = node.querySelector(".saved-room-meta");
  const actions = node.querySelector(".saved-room-actions");
  const members = node.querySelector(".saved-room-members");

  badge.textContent = room.active ? "activa" : "historial";
  badge.classList.toggle("offline", !room.active);
  badge.classList.toggle("creator-badge", room.isCreator);
  title.textContent = room.roomName || "Sala LastSeen";
  meta.textContent = roomMeta(room);

  if (room.active) {
    actions.appendChild(actionLink("Entrar en la sala", roomURL(room.roomId), ""));
  }

  if (room.isCreator && room.creatorToken) {
    const manage = actionLink(room.active ? "Gestionar" : "Abrir gestión local", roomURL(room.roomId), "secondary");
    actions.appendChild(manage);
    if (room.active) {
      actions.appendChild(actionButton("+ duración", "secondary", () => updateRoomTTL(room, 180)));
      actions.appendChild(actionButton("Terminar", "danger", () => endRoom(room)));
    }
  }

  actions.appendChild(actionButton("Revisar historial", "secondary", () => {
    const details = node.querySelector(".saved-room-history");
    details.open = !details.open;
  }));

  renderHistoryMembers(members, Object.values(room.membersHistory || {}));
  return node;
}

function roomMeta(room) {
  const parts = [];
  parts.push(`Código: ${room.roomId}`);
  parts.push(room.isCreator ? "creada por este dispositivo" : "participante");
  if (room.active && room.ttl) parts.push(`queda aprox. ${formatDuration(room.ttl)}`);
  if (room.lastJoinedAt) parts.push(`última entrada: ${formatDate(room.lastJoinedAt)}`);
  else if (room.createdAt) parts.push(`creada: ${formatDate(room.createdAt)}`);
  const count = Object.keys(room.membersHistory || {}).length;
  parts.push(`${count} usuario${count === 1 ? "" : "s"} en historial local`);
  return parts.join(" · ");
}

function actionLink(label, href, className) {
  const link = document.createElement("a");
  link.href = href;
  link.className = `button-like ${className || ""}`.trim();
  link.textContent = label;
  return link;
}

function actionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className || "";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function updateRoomTTL(room, ttlMinutes) {
  if (!room.creatorToken) return;
  try {
    const response = await fetch(apiURL(`/api/rooms/${encodeURIComponent(room.roomId)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Creator-Token": room.creatorToken },
      body: JSON.stringify({ ttlMinutes, creatorToken: room.creatorToken })
    });
    if (!response.ok) throw new Error("No se pudo ampliar la sala.");
    await renderRoomDashboard();
  } catch (error) {
    window.alert(error.message || "Error ampliando la sala.");
  }
}

async function endRoom(room) {
  if (!room.creatorToken) return;
  if (!window.confirm(`¿Terminar la sala ${room.roomName}?`)) return;

  try {
    const response = await fetch(apiURL(`/api/rooms/${encodeURIComponent(room.roomId)}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Creator-Token": room.creatorToken },
      body: JSON.stringify({ creatorToken: room.creatorToken })
    });
    if (!response.ok) throw new Error("No se pudo terminar la sala.");
    await renderRoomDashboard();
  } catch (error) {
    window.alert(error.message || "Error terminando la sala.");
  }
}

function renderHistoryMembers(target, history) {
  target.innerHTML = "";
  if (history.length === 0) {
    target.innerHTML = `<p class="hint">Sala guardada. Aún no hay miembros en el historial local.</p>`;
    return;
  }

  history
    .sort((a, b) => Date.parse(b.seen || b.archivedAt || "") - Date.parse(a.seen || a.archivedAt || ""))
    .slice(0, 8)
    .forEach(member => target.appendChild(renderHistoryMember(member)));
}

function renderHistoryMember(member) {
  const row = document.createElement("div");
  row.className = `member ${member.geo ? "geo-alert" : ""}`;
  const coords = hasLatLng(member) ? `${member.lat}, ${member.lng}` : "Sin ubicación GPS guardada";
  const seen = member.seen ? formatDate(member.seen) : "sin señal";
  const battery = member.bat ? ` · batería ${Math.round(member.bat * 100)}%` : "";
  row.innerHTML = `
    <div class="avatar" aria-hidden="true">${escapeHTML(member.avatar || "•")}</div>
    <div class="member-main">
      <strong>${escapeHTML(member.nick || "Sin mote")}</strong><br />
      <small>${coords}<br />Última señal: ${seen}${battery}</small>
    </div>
    <span class="badge ${member.on ? "" : "offline"}">${member.on ? "online" : "last seen"}</span>
  `;
  return row;
}

function saveRoomState(roomID, state) {
  localStorage.setItem(roomKey(roomID), JSON.stringify(state));
  localStorage.setItem("lastseen:last-room", roomID);
  addRoomToIndex(roomID);
}

function readRoomIndex() {
  const value = readJSON(ROOM_INDEX_KEY);
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function saveRoomIndex(roomIDs) {
  localStorage.setItem(ROOM_INDEX_KEY, JSON.stringify([...new Set(roomIDs.filter(Boolean))]));
}

function addRoomToIndex(roomID) {
  saveRoomIndex([roomID, ...readRoomIndex()]);
}

function roomKey(roomID) {
  return `lastseen:${roomID}:state`;
}

function apiBaseURL() {
  const configured = String(window.LASTSEEN_API_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return window.location.origin;
}

function apiURL(path) {
  return `${apiBaseURL()}${path}`;
}

function roomURL(roomID) {
  return new URL(`./room.html?r=${encodeURIComponent(roomID)}`, document.baseURI).toString();
}

function extractRoomID(pathOrURL) {
  if (!pathOrURL) return "";
  const match = String(pathOrURL).match(/\/room\/([^/?#]+)/);
  return match?.[1] || "";
}

function generateClientID() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hasLatLng(value) {
  return typeof value?.lat === "number" && typeof value?.lng === "number" && !(value.lat === 0 && value.lng === 0);
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds) / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
}

function formatDate(value) {
  return new Date(value).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
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
