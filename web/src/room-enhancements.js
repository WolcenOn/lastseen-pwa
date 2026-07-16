const roomID = getRoomID();
let autoJoinAttempted = false;
let leaveHandled = false;
let reconcileBusy = false;

if (roomID) {
  restoreKnownRoomIdentity(roomID);
  ensureCreatorControls(roomID);
  wireLocalLeave(roomID);
  autoJoinKnownRoom(roomID);
  startRoomViewReconciler(roomID);
}

function restoreKnownRoomIdentity(id) {
  const state = loadRoomState(id);
  if (!hasSavedIdentity(state)) return;

  const nicknameInput = document.querySelector("#nickname");
  const pinInput = document.querySelector("#pin");
  const joinButton = document.querySelector("#join-room");

  if (nicknameInput) nicknameInput.value = state.nickname;
  if (pinInput) pinInput.value = state.pin;
  selectAvatar(state.avatar);

  if (joinButton) {
    joinButton.textContent = `Entrar como ${state.avatar} ${state.nickname}`;
  }

  const status = document.querySelector("#status");
  if (status) {
    status.textContent = "Identidad recuperada para esta sala. Entrando con el mismo usuario…";
  }
}

function autoJoinKnownRoom(id) {
  const state = loadRoomState(id);
  if (!hasSavedIdentity(state) || autoJoinAttempted) return;

  const params = new URLSearchParams(window.location.search);
  if (params.get("manual") === "1") return;

  autoJoinAttempted = true;
  setTimeout(() => {
    const joinCard = document.querySelector("#join-card");
    const roomCard = document.querySelector("#room-card");
    const joinButton = document.querySelector("#join-room");

    if (!joinButton || joinButton.disabled) return;
    if (roomCard && !roomCard.hidden) return;
    if (joinCard && joinCard.hidden) return;

    joinButton.click();
  }, 550);
}

function wireLocalLeave(id) {
  const leaveButton = document.querySelector("#leave-room");
  if (!leaveButton) return;

  leaveButton.textContent = "Salir de la sala";
  leaveButton.addEventListener("click", event => {
    if (leaveHandled) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const state = loadRoomState(id) || { roomId: id };
    const savedPIN = String(state.pin || "").trim();
    if (savedPIN) {
      const enteredPIN = window.prompt("Introduce tu PIN para salir de la sala:");
      if (enteredPIN === null) return;
      if (String(enteredPIN).trim() !== savedPIN) {
        const status = document.querySelector("#room-status") || document.querySelector("#status");
        if (status) status.textContent = "PIN incorrecto. No se ha salido de la sala.";
        return;
      }
    } else if (!window.confirm("No hay PIN guardado para esta sesión. ¿Salir de la sala igualmente?")) {
      return;
    }

    leaveHandled = true;
    trySendSelfDisconnect(savedPIN);

    state.lastLeftAt = new Date().toISOString();
    state.autoJoinDisabledUntil = Date.now() + 2500;
    saveRoomState(id, state);

    const status = document.querySelector("#room-status") || document.querySelector("#status");
    if (status) status.textContent = "Has salido de la sala. Volviendo al inicio…";

    setTimeout(() => {
      window.location.href = new URL("./", document.baseURI).toString();
    }, 160);
  }, { capture: true });
}

function trySendSelfDisconnect(pin) {
  try {
    if (typeof socket !== "undefined" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: "disconnect", pin }));
      socket.close(1000, "user left");
    }
  } catch {
    // Best effort only. Navigation will close the WebSocket if this fails.
  }
}

function startRoomViewReconciler(id) {
  const run = () => reconcileRoomView(id);
  run();

  const membersEl = document.querySelector("#members");
  if (membersEl) {
    new MutationObserver(() => scheduleReconcile(id)).observe(membersEl, { childList: true, subtree: true });
  }

  const mapEl = document.querySelector("#map");
  if (mapEl) {
    new MutationObserver(() => scheduleReconcile(id)).observe(mapEl, { childList: true, subtree: true });
  }

  setInterval(run, 350);
}

function scheduleReconcile(id) {
  if (reconcileBusy) return;
  reconcileBusy = true;
  requestAnimationFrame(() => {
    reconcileBusy = false;
    reconcileRoomView(id);
  });
}

function reconcileRoomView(id) {
  const state = normalizeStoredRoomState(id);
  ensureCreatorControls(id, state);
  reconcileDuplicateMemberRows();
  labelAndSuppressDuplicateMarkersFromVisibleRows();
}

function normalizeStoredRoomState(id) {
  const state = loadRoomState(id);
  if (!state) return null;

  const backupToken = readCreatorTokenBackup(id);
  if (!state.creatorToken && backupToken) state.creatorToken = backupToken;
  if (state.creatorToken) state.isCreator = true;
  state.membersHistory = latestMembersByLogicalUser(state.membersHistory || {});
  saveRoomState(id, state);
  return state;
}

function latestMembersByLogicalUser(history) {
  const byLogicalUser = new Map();

  Object.values(history || {}).forEach(member => {
    if (!member) return;
    const key = logicalUserKey(member);
    const previous = byLogicalUser.get(key);
    if (!previous || compareMembers(member, previous) >= 0) {
      byLogicalUser.set(key, member);
    }
  });

  const normalized = {};
  for (const member of byLogicalUser.values()) {
    const key = member.id || logicalUserKey(member);
    normalized[key] = member;
  }
  return normalized;
}

function reconcileDuplicateMemberRows() {
  const rows = [...document.querySelectorAll("#members .member")];
  if (rows.length < 2) return;

  const bestByKey = new Map();
  rows.forEach((row, index) => {
    const key = rowLogicalKey(row);
    if (!key) return;

    const candidate = { row, score: rowScore(row, index) };
    const previous = bestByKey.get(key);
    if (!previous || candidate.score >= previous.score) {
      bestByKey.set(key, candidate);
    }
  });

  rows.forEach(row => {
    const key = rowLogicalKey(row);
    if (!key) return;
    const keep = bestByKey.get(key)?.row;
    if (keep && keep !== row) row.remove();
  });
}

function labelAndSuppressDuplicateMarkersFromVisibleRows() {
  const currentMembers = currentMembersFromVisibleRows();
  const queuesByAvatar = new Map();

  currentMembers.forEach(member => {
    const avatar = String(member.avatar || "•");
    const queue = queuesByAvatar.get(avatar) || [];
    queue.push(member);
    queuesByAvatar.set(avatar, queue);
  });

  document.querySelectorAll(".leaflet-marker-icon").forEach(outer => {
    outer.classList.remove("member-marker-hidden");
  });

  document.querySelectorAll(".leaflet-marker-icon .member-marker").forEach(marker => {
    const avatar = markerAvatar(marker);
    const queue = queuesByAvatar.get(avatar) || [];
    const member = queue.shift();

    if (!member) {
      hideMarker(marker);
      return;
    }

    marker.dataset.userKey = logicalUserKey(member);
    marker.innerHTML = `
      <span class="member-marker-avatar">${escapeHTML(member.avatar || "•")}</span>
      <span class="member-marker-label">${escapeHTML(shortName(member.nick || "Sin mote"))}</span>
    `;
  });
}

function currentMembersFromVisibleRows() {
  return [...document.querySelectorAll("#members .member")]
    .map(rowToMember)
    .filter(Boolean)
    .sort((a, b) => String(a.nick || "").localeCompare(String(b.nick || "")));
}

function rowToMember(row) {
  const avatar = row.querySelector(".avatar")?.textContent?.trim() || "";
  const nick = row.querySelector("strong")?.textContent?.trim() || "";
  if (!avatar && !nick) return null;
  return {
    avatar,
    nick,
    on: rowLooksOnline(row),
    geo: row.classList.contains("geo-alert")
  };
}

function hideMarker(marker) {
  const outer = marker.closest(".leaflet-marker-icon");
  if (outer) outer.classList.add("member-marker-hidden");
}

function ensureCreatorControls(id, providedState = null) {
  const state = providedState || loadRoomState(id);
  const panel = document.querySelector("#creator-panel");
  if (!panel) return;

  const help = document.querySelector("#creator-help");
  const status = document.querySelector("#creator-status");

  if (!state?.creatorToken) {
    panel.hidden = false;
    panel.classList.add("locked");
    panel.querySelectorAll("select, button").forEach(control => {
      control.disabled = true;
    });
    if (help) help.textContent = "Gestión bloqueada: este dispositivo no conserva el token de creador de esta sala.";
    if (status && !status.textContent) status.textContent = "Crea una sala nueva con la versión actual para guardar el token de creador.";
    return;
  }

  state.isCreator = true;
  saveRoomState(id, state);

  panel.hidden = false;
  panel.classList.remove("locked");
  panel.querySelectorAll("select, button").forEach(control => {
    control.disabled = false;
  });

  if (help) help.textContent = "Gestión activa: este navegador conserva el token de creador de esta sala.";
  if (status && (!status.textContent || status.textContent.includes("bloqueada") || status.textContent.includes("nueva"))) {
    status.textContent = "Puedes modificar duración o terminar la sala.";
  }
}

function hasSavedIdentity(state) {
  if (!state?.roomId || !state?.clientId || !state?.nickname || !state?.pin || !state?.avatar) return false;
  if (Number(state.autoJoinDisabledUntil || 0) > Date.now()) return false;
  return true;
}

function rowLogicalKey(row) {
  const avatar = row.querySelector(".avatar")?.textContent?.trim() || "";
  const nick = row.querySelector("strong")?.textContent?.trim().toLowerCase() || "";
  return nick || avatar ? `${nick}|${avatar}` : "";
}

function rowLooksOnline(row) {
  const badge = row.querySelector(".badge")?.textContent?.trim().toLowerCase() || "";
  return badge.includes("online");
}

function rowScore(row, index) {
  const online = rowLooksOnline(row) ? 1000000 : 0;
  const text = row.textContent || "";
  const hasCoords = /-?\d+\.\d+/.test(text) ? 10000 : 0;
  return online + hasCoords + index;
}

function markerAvatar(marker) {
  const avatarNode = marker.querySelector(".member-marker-avatar");
  if (avatarNode) return avatarNode.textContent.trim();
  const raw = String(marker.textContent || "•").trim();
  return raw.match(/^\p{Extended_Pictographic}/u)?.[0] || raw.slice(0, 2) || "•";
}

function logicalUserKey(member) {
  const nick = String(member.nick || "").trim().toLowerCase();
  const avatar = String(member.avatar || "").trim();
  return nick || avatar ? `${nick}|${avatar}` : String(member.id || "unknown");
}

function compareMembers(left, right) {
  if (Boolean(left?.on) !== Boolean(right?.on)) return left?.on ? 1 : -1;
  return memberTime(left) - memberTime(right);
}

function memberTime(member) {
  return Date.parse(member?.seen || member?.archivedAt || "") || 0;
}

function shortName(value) {
  const clean = String(value).trim();
  return clean.length > 12 ? `${clean.slice(0, 11)}…` : clean;
}

function selectAvatar(avatar) {
  document.querySelectorAll("#avatar-picker .avatar-choice").forEach(button => {
    const selected = button.textContent.trim() === avatar;
    button.classList.toggle("selected", selected);
    if (selected) button.click();
  });
}

function loadRoomState(id) {
  try {
    const state = JSON.parse(localStorage.getItem(roomKey(id)) || "null") || { roomId: id };
    if (state && !state.roomId) state.roomId = id;
    const backupToken = readCreatorTokenBackup(id);
    if (state && !state.creatorToken && backupToken) {
      state.creatorToken = backupToken;
      state.isCreator = true;
      saveRoomState(id, state);
    }
    return state;
  } catch {
    const backupToken = readCreatorTokenBackup(id);
    return backupToken ? { roomId: id, isCreator: true, creatorToken: backupToken } : null;
  }
}

function saveRoomState(id, state) {
  if (state?.creatorToken) persistCreatorTokenBackup(id, state.creatorToken);
  localStorage.setItem(roomKey(id), JSON.stringify(state));
}

function roomKey(id) {
  return `lastseen:${id}:state`;
}

function creatorTokenKey(id) {
  return `lastseen:${id}:creator-token`;
}

function persistCreatorTokenBackup(id, token) {
  const clean = String(token || "").trim();
  if (!id || !clean) return;
  localStorage.setItem(creatorTokenKey(id), clean);
  try {
    sessionStorage.setItem(creatorTokenKey(id), clean);
  } catch {
    // sessionStorage may be unavailable in some privacy modes.
  }
}

function readCreatorTokenBackup(id) {
  if (!id) return "";
  try {
    return localStorage.getItem(creatorTokenKey(id)) || sessionStorage.getItem(creatorTokenKey(id)) || "";
  } catch {
    return localStorage.getItem(creatorTokenKey(id)) || "";
  }
}

function getRoomID() {
  const params = new URLSearchParams(window.location.search);
  const queryRoomID = params.get("r") || params.get("room");
  if (queryRoomID) return queryRoomID;
  const match = window.location.pathname.match(/\/room\/([^/]+)$/);
  return match?.[1] || "";
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
