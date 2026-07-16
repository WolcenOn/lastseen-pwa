import assert from "node:assert/strict";
import {
  createRoomStore,
  normalizeMembers,
  normalizeMembersHistory,
  preferMember
} from "./room-store.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] || null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
const session = new MemoryStorage();
const store = createRoomStore(storage, session);

const saved = store.saveRoomState("room-1", {
  roomName: "Prueba",
  isCreator: false,
  creatorToken: " token ",
  membersHistory: {
    old: { id: "client-1", nick: "Ana", on: false, seen: "2026-01-01T10:00:00.000Z" },
    fresh: { id: "client-1", nick: "Ana", on: true, seen: "2026-01-01T10:01:00.000Z", lat: 40, lng: -3 }
  }
});

assert.equal(saved.isCreator, true);
assert.equal(saved.creatorToken, "token");
assert.equal(store.readCreatorTokenBackup("room-1"), "token");
assert.deepEqual(store.readRoomIndex(), ["room-1"]);

const loaded = store.loadRoomState("room-1");
assert.equal(loaded.roomName, "Prueba");
assert.equal(Object.keys(loaded.membersHistory).length, 1);
assert.equal(loaded.membersHistory["client-1"].on, true);

const members = normalizeMembers([
  { id: "b", nick: "B", on: false, seen: "2026-01-01T10:00:00.000Z" },
  { id: "a", nick: "A", on: true, seen: "2026-01-01T09:00:00.000Z" },
  { id: "b", nick: "B", on: true, seen: "2026-01-01T10:01:00.000Z", lat: 40, lng: -3 }
]);

assert.equal(members.length, 2);
assert.equal(members[0].id, "b");
assert.equal(members[0].on, true);

const history = normalizeMembersHistory({
  one: { id: "x", nick: "X", on: false, seen: "2026-01-01T10:00:00.000Z" },
  two: { id: "x", nick: "X", on: true, seen: "2026-01-01T10:02:00.000Z" }
});
assert.equal(Object.keys(history).length, 1);
assert.equal(history.x.on, true);

assert.equal(preferMember({ id: "y", on: true }, { id: "y", on: false }).on, true);

console.log("room-store tests passed");
