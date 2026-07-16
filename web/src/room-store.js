const ROOM_INDEX_KEY = "lastseen:rooms";
const ROOM_STATE_PREFIX = "lastseen:";
const ROOM_STATE_SUFFIX = ":state";
const CREATOR_TOKEN_SUFFIX = ":creator-token";

export function createRoomStore(storage = defaultStorage(), sessionStorageRef = defaultSessionStorage()) {
  return {
    roomKey,
    creatorTokenKey,
    readJSON: key => readJSON(storage, key),
    writeJSON: (key, value) => writeJSON(storage, key, value),
    readRoomIndex: () => readRoomIndex(storage),
    saveRoomIndex: roomIDs => saveRoomIndex(storage, roomIDs),
    addRoomToIndex: roomID => addRoomToIndex(storage, roomID),
    loadRoomState: roomID => loadRoomState(storage, sessionStorageRef, roomID),
    saveRoomState: (roomID, state) => saveRoomState(storage, sessionStorageRef, roomID, state),
    persistCreatorTokenBackup: (roomID, token) => persistCreatorTokenBackup(storage, sessionStorageRef, roomID, token),
    readCreatorTokenBackup: roomID => readCreatorTokenBackup(storage, sessionStorageRef, roomID),
    normalizeRoomState: (roomID, state) => normalizeRoomState(storage, sessionStorageRef, roomID, state),
    normalizeMembers,
    normalizeMembersHistory,
    normalizeMember,
    memberKey,
    preferMember,
    sortMembersByStatus,
    hasLatLng
  };
}

export const roomStore = createRoomStore();

function defaultStorage() {
  return globalThis.localStorage || createMemoryStorage();
}

function defaultSessionStorage() {
  return globalThis.sessionStorage || createMemoryStorage();
}

function createMemoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] || null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    }
  };
}

export function roomKey(roomID) {
  return `${ROOM_STATE_PREFIX}${roomID}${ROOM_STATE_SUFFIX}`;
}

export function creatorTokenKey(roomID) {
  return `${ROOM_STATE_PREFIX}${roomID}${CREATOR_TOKEN_SUFFIX}`;
}

export function readJSON(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

export function writeJSON(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
}

export function readRoomIndex(storage) {
  const value = readJSON(storage, ROOM_INDEX_KEY);
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function saveRoomIndex(storage, roomIDs) {
  writeJSON(storage, ROOM_INDEX_KEY, [...new Set((roomIDs || []).filter(Boolean))]);
}

export function addRoomToIndex(storage, roomID) {
  if (!roomID) return;
  saveRoomIndex(storage, [roomID, ...readRoomIndex(storage)]);
}

export function normalizeRoomState(storage, sessionStorageRef, roomID, state = {}) {
  const creatorToken = String(state.creatorToken || readCreatorTokenBackup(storage, sessionStorageRef, roomID) || "").trim();
  const normalized = {
    roomId: state.roomId || roomID,
    roomName: state.roomName || "Sala LastSeen",
    clientId: state.clientId || "",
    nickname: state.nickname || "",
    pin: state.pin || "",
    avatar: state.avatar || "",
    isCreator: Boolean(state.isCreator || creatorToken),
    creatorToken,
    ttl: Number(state.ttl || 0),
    createdAt: state.createdAt || "",
    lastJoinedAt: state.lastJoinedAt || "",
    endedAt: state.endedAt || "",
    active: Boolean(state.active),
    membersHistory: normalizeMembersHistory(state.membersHistory || {}),
    safety: state.safety || {}
  };

  if (creatorToken) persistCreatorTokenBackup(storage, sessionStorageRef, roomID, creatorToken);
  return normalized;
}

export function loadRoomState(storage, sessionStorageRef, roomID) {
  return normalizeRoomState(storage, sessionStorageRef, roomID, readJSON(storage, roomKey(roomID)) || {});
}

export function saveRoomState(storage, sessionStorageRef, roomID, state) {
  const normalized = normalizeRoomState(storage, sessionStorageRef, roomID, state || {});
  writeJSON(storage, roomKey(roomID), normalized);
  storage.setItem("lastseen:last-room", roomID);
  addRoomToIndex(storage, roomID);
  if (normalized.creatorToken) persistCreatorTokenBackup(storage, sessionStorageRef, roomID, normalized.creatorToken);
  return normalized;
}

export function persistCreatorTokenBackup(storage, sessionStorageRef, roomID, token) {
  const clean = String(token || "").trim();
  if (!roomID || !clean) return;
  storage.setItem(creatorTokenKey(roomID), clean);
  try {
    sessionStorageRef?.setItem(creatorTokenKey(roomID), clean);
  } catch {
    // sessionStorage can be unavailable in privacy modes.
  }
}

export function readCreatorTokenBackup(storage, sessionStorageRef, roomID) {
  if (!roomID) return "";
  try {
    return storage.getItem(creatorTokenKey(roomID)) || sessionStorageRef?.getItem(creatorTokenKey(roomID)) || "";
  } catch {
    return storage.getItem(creatorTokenKey(roomID)) || "";
  }
}

export function normalizeMembers(list) {
  const byID = new Map();
  (list || []).filter(Boolean).forEach(member => {
    const normalized = normalizeMember(member);
    if (!normalized.id) return;
    const previous = byID.get(normalized.id);
    byID.set(normalized.id, preferMember(normalized, previous));
  });
  return [...byID.values()].sort(sortMembersByStatus);
}

export function normalizeMembersHistory(history) {
  const result = {};
  normalizeMembers(Object.values(history || {})).forEach(member => {
    result[member.id] = member;
  });
  return result;
}

export function normalizeMember(member) {
  return {
    ...member,
    id: String(member.id || "").trim(),
    nick: String(member.nick || member.nickname || "").trim(),
    avatar: String(member.avatar || "").trim(),
    lat: typeof member.lat === "number" ? member.lat : Number(member.lat),
    lng: typeof member.lng === "number" ? member.lng : Number(member.lng),
    bat: typeof member.bat === "number" ? member.bat : Number(member.bat || 0),
    on: Boolean(member.on),
    geo: Boolean(member.geo),
    sos: Boolean(member.sos),
    seen: member.seen || member.archivedAt || new Date().toISOString()
  };
}

export function memberKey(member) {
  return String(member?.id || "").trim();
}

export function preferMember(next, current) {
  if (!current) return next;
  if (Boolean(next.on) !== Boolean(current.on)) return next.on ? next : current;
  if (hasLatLng(next) !== hasLatLng(current)) return hasLatLng(next) ? next : current;

  const nextSeen = Date.parse(next.seen || next.archivedAt || "") || 0;
  const currentSeen = Date.parse(current.seen || current.archivedAt || "") || 0;
  return nextSeen >= currentSeen ? { ...current, ...next } : { ...next, ...current };
}

export function sortMembersByStatus(left, right) {
  if (Boolean(left.on) !== Boolean(right.on)) return left.on ? -1 : 1;
  const leftSeen = Date.parse(left.seen || left.archivedAt || "") || 0;
  const rightSeen = Date.parse(right.seen || right.archivedAt || "") || 0;
  if (leftSeen !== rightSeen) return rightSeen - leftSeen;
  return String(left.nick || left.id).localeCompare(String(right.nick || right.id));
}

export function hasLatLng(value) {
  return Number.isFinite(value?.lat) && Number.isFinite(value?.lng) && !(value.lat === 0 && value.lng === 0);
}
