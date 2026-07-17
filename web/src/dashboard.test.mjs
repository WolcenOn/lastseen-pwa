import assert from "node:assert/strict";

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

function createElementStub() {
  return {
    addEventListener() {},
    appendChild() {},
    classList: { toggle() {}, add() {}, remove() {} },
    content: { firstElementChild: { cloneNode: () => createElementStub() } },
    dataset: {},
    disabled: false,
    hidden: false,
    href: "",
    innerHTML: "",
    open: false,
    prepend() {},
    querySelector: () => createElementStub(),
    remove() {},
    set textContent(value) { this._textContent = value; },
    get textContent() { return this._textContent || ""; },
    type: "",
    value: ""
  };
}

const storage = new MemoryStorage();
const session = new MemoryStorage();

globalThis.localStorage = storage;
globalThis.sessionStorage = session;
globalThis.window = {
  location: { origin: "https://example.test" },
  alert() {},
  confirm: () => true,
  LASTSEEN_API_BASE_URL: "https://api.example.test"
};
globalThis.document = {
  baseURI: "https://example.test/lastseen-pwa/",
  querySelector: () => null,
  createElement: () => createElementStub()
};

if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(values) {
        values.fill(1);
        return values;
      }
    }
  });
}

globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "", json: async () => ({}) });

await import("./dashboard.js");

assert.equal(typeof window.LASTSEEN_API_BASE_URL, "string");
console.log("dashboard smoke test passed");