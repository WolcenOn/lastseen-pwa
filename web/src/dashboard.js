const dashboardEl = document.querySelector("#room-dashboard");
const refreshDashboardButton = document.querySelector("#refresh-room-dashboard");
const roomCardTemplate = document.querySelector("#room-card-template");

const ROOM_KEY_PATTERN = /^lastseen:(.+):state$/;

if (dashboardEl) {
  refreshDashboardButton?.addEventListener("click", renderRoomDashboard);
  renderRoomDashboard();
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
  const rooms = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const match = key?.match(ROOM_KEY_PATTERN);
    if (!match) continue;

    const state = readJSON(key);
    if (!state) continue;

    rooms.push(normalizeRoomState(match[1], state));
  }
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
    return {
      ...room,
      active: true,
      localOnly: false,
      serverRoom,
      roomName: serverRoom.name || room.roomName,
      ttl: Number(serverRoom.ttl || room.ttl || 0),
      safety: serverRoom.safety || room.safety || {}
    };
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
  return Math.max(joined || 0, ...historyTimes, 0);
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
    target.innerHTML = `<p class="hint">Sin historial local de miembros.</p>`;
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
