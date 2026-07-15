const roomID = getRoomID();
let autoJoinAttempted = false;

if (roomID) {
  restoreKnownRoomIdentity(roomID);
  ensureCreatorControls(roomID);
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

function startRoomViewReconciler(id) {
  const run = () => {
    const state = normalizeStoredRoomState(id);
    ensureCreatorControls(id, state);
    reconcileDuplicateMemberRows(state);
    labelAndSuppressDuplicateMarkers(state);
  };

  run();
  setInterval(run, 700);
}

function normalizeStoredRoomState(id) {
  const state = loadRoomState(id);
  if (!state) return null;

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

function reconcileDuplicateMemberRows(state) {
  if (!state) return;
  const rows = [...document.querySelectorAll("#members .member")];
  const byKey = new Map();

  rows.forEach(row => {
    row.hidden = false;
    const key = rowLogicalKey(row);
    if (!key) return;

    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, row);
      return;
    }

    const keepCurrent = rowLooksOnline(row) && !rowLooksOnline(previous);
    if (keepCurrent) {
      previous.hidden = true;
      byKey.set(key, row);
    } else {
      row.hidden = true;
    }
  });
}

function labelAndSuppressDuplicateMarkers(state) {
  if (!state) return;

  const members = latestMembers(state);
  if (members.length === 0) return;

  const queuesByAvatar = new Map();
  members.forEach(member => {
    const avatar = String(member.avatar || "•");
    const queue = queuesByAvatar.get(avatar) || [];
    queue.push(member);
    queuesByAvatar.set(avatar, queue);
  });

  const seenKeys = new Set();
  document.querySelectorAll(".leaflet-marker-icon .member-marker").forEach(marker => {
    marker.closest(".leaflet-marker-icon")?.classList.remove("member-marker-hidden");

    const avatar = markerAvatar(marker);
    const queue = queuesByAvatar.get(avatar) || [];
    const member = queue.shift();

    if (!member) {
      hideMarker(marker);
      return;
    }

    const key = logicalUserKey(member);
    if (seenKeys.has(key)) {
      hideMarker(marker);
      return;
    }
    seenKeys.add(key);

    marker.dataset.userKey = key;
    marker.innerHTML = `
      <span class="member-marker-avatar">${escapeHTML(member.avatar || "•")}</span>
      <span class="member-marker-label">${escapeHTML(shortName(member.nick || "Sin mote"))}</span>
    `;
  });
}

function hideMarker(marker) {
  const outer = marker.closest(".leaflet-marker-icon");
  if (outer) outer.classList.add("member-marker-hidden");
}

function latestMembers(state) {
  const history = Object.values(state.membersHistory || {});
  const byLogicalUser = new Map();

  history.forEach(member => {
    if (!member) return;
    const key = logicalUserKey(member);
    const previous = byLogicalUser.get(key);
    if (!previous || compareMembers(member, previous) >= 0) {
      byLogicalUser.set(key, member);
    }
  });

  if (state.clientId && state.nickname) {
    const self = {
      id: state.clientId,
      nick: state.nickname,
      avatar: state.avatar,
      on: true,
      seen: new Date().toISOString()
    };
    const key = logicalUserKey(self);
    const previous = byLogicalUser.get(key);
    byLogicalUser.set(key, { ...(previous || {}), ...self });
  }

  return [...byLogicalUser.values()].sort((a, b) => String(a.nick || "").localeCompare(String(b.nick || "")));
}

function ensureCreatorControls(id, providedState = null) {
  const state = providedState || loadRoomState(id);
  const panel = document.querySelector("#creator-panel");
  if (!panel || !state?.creatorToken) return;

  panel.hidden = false;
  panel.classList.remove("locked");
  panel.querySelectorAll("select, button").forEach(control => {
    control.disabled = false;
  });

  const help = document.querySelector("#creator-help");
  const status = document.querySelector("#creator-status");
  if (help) help.textContent = "Gestión activa: este navegador conserva el token de creador de esta sala.";
  if (status && !status.textContent) status.textContent = "Puedes modificar duración o terminar la sala.";
}

function hasSavedIdentity(state) {
  return Boolean(state?.roomId && state?.clientId && state?.nickname && state?.pin && state?.avatar);
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

function markerAvatar(marker) {
  const avatarNode = marker.querySelector(".member-marker-avatar");
  if (avatarNode) return avatarNode.textContent.trim();
  return marker.childNodes.length > 0 ? String(marker.childNodes[0].textContent || marker.textContent || "•").trim().slice(0, 2) : "•";
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
    const state = JSON.parse(localStorage.getItem(roomKey(id)) || "null");
    if (state && !state.roomId) state.roomId = id;
    return state;
  } catch {
    return null;
  }
}

function saveRoomState(id, state) {
  localStorage.setItem(roomKey(id), JSON.stringify(state));
}

function roomKey(id) {
  return `lastseen:${id}:state`;
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
