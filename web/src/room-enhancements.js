const roomID = getRoomID();

if (roomID) {
  restoreKnownRoomIdentity(roomID);
  maybeAutoJoinKnownRoom(roomID);
  startMarkerLabelEnhancer(roomID);
}

function restoreKnownRoomIdentity(id) {
  const state = loadRoomState(id);
  if (!state) return;

  const nicknameInput = document.querySelector("#nickname");
  const pinInput = document.querySelector("#pin");
  const joinButton = document.querySelector("#join-room");

  if (state.nickname && nicknameInput && !nicknameInput.value) nicknameInput.value = state.nickname;
  if (state.pin && pinInput && !pinInput.value) pinInput.value = state.pin;
  if (joinButton && state.nickname && state.avatar) {
    joinButton.textContent = `Entrar como ${state.avatar} ${state.nickname}`;
  }

  if (state.avatar) {
    requestAnimationFrame(() => selectAvatar(state.avatar));
    setTimeout(() => selectAvatar(state.avatar), 120);
  }

  if (state.nickname && state.pin) {
    const status = document.querySelector("#status");
    if (status) status.textContent = "Identidad recuperada de esta sala. Puedes entrar con el mismo usuario.";
  }
}

function maybeAutoJoinKnownRoom(id) {
  const state = loadRoomState(id);
  if (!state?.nickname || !state?.pin || !state?.avatar || !state?.clientId) return;
  if (sessionStorage.getItem(autoJoinKey(id)) === "done") return;

  const params = new URLSearchParams(window.location.search);
  const shouldAutoJoin = params.get("auto") === "1" || params.get("resume") === "1";
  if (!shouldAutoJoin) return;

  sessionStorage.setItem(autoJoinKey(id), "done");
  const joinButton = document.querySelector("#join-room");
  setTimeout(() => {
    if (!joinButton || joinButton.disabled || document.querySelector("#join-card")?.hidden) return;
    joinButton.click();
  }, 350);
}

function startMarkerLabelEnhancer(id) {
  const apply = () => labelVisibleMarkers(loadRoomState(id));
  apply();
  setInterval(apply, 1000);
}

function labelVisibleMarkers(state) {
  if (!state) return;
  const members = latestMembers(state);
  if (members.length === 0) return;

  const avatarQueues = new Map();
  members.forEach(member => {
    const avatar = String(member.avatar || "•");
    const queue = avatarQueues.get(avatar) || [];
    queue.push(member);
    avatarQueues.set(avatar, queue);
  });

  document.querySelectorAll(".leaflet-marker-icon .member-marker").forEach(marker => {
    if (marker.dataset.enhanced === "1") return;
    const avatar = marker.textContent.trim();
    const queue = avatarQueues.get(avatar) || [];
    const member = queue.shift();
    if (!member) return;

    marker.dataset.enhanced = "1";
    marker.innerHTML = `
      <span class="member-marker-avatar">${escapeHTML(member.avatar || "•")}</span>
      <span class="member-marker-label">${escapeHTML(shortName(member.nick || "Sin mote"))}</span>
    `;
  });
}

function latestMembers(state) {
  const history = Object.values(state.membersHistory || {});
  const byLogicalUser = new Map();

  history.forEach(member => {
    if (!member) return;
    const key = logicalUserKey(member);
    const previous = byLogicalUser.get(key);
    if (!previous || memberTime(member) >= memberTime(previous)) {
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

function logicalUserKey(member) {
  const nick = String(member.nick || "").trim().toLowerCase();
  const avatar = String(member.avatar || "").trim();
  return nick || avatar ? `${nick}|${avatar}` : String(member.id || "unknown");
}

function memberTime(member) {
  return Date.parse(member.seen || member.archivedAt || "") || 0;
}

function shortName(value) {
  const clean = String(value).trim();
  return clean.length > 10 ? `${clean.slice(0, 9)}…` : clean;
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
    return JSON.parse(localStorage.getItem(`lastseen:${id}:state`) || "null");
  } catch {
    return null;
  }
}

function getRoomID() {
  const params = new URLSearchParams(window.location.search);
  const queryRoomID = params.get("r") || params.get("room");
  if (queryRoomID) return queryRoomID;
  const match = window.location.pathname.match(/\/room\/([^/]+)$/);
  return match?.[1] || "";
}

function autoJoinKey(id) {
  return `lastseen:${id}:autojoin`;
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
