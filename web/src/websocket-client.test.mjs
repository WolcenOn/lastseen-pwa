import assert from "node:assert/strict";
import { ReconnectingWebSocketClient, SOCKET_STATES, createReconnectBackoff } from "./websocket-client.js";

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, detail = {}) {
    for (const listener of this.listeners.get(type) || []) listener(detail);
  }
}

class FakeWebSocket extends FakeEventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  receive(data) {
    this.dispatch("message", { data });
  }

  failClose(code = 1006, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
    this.dispatch("close", { code, reason });
  }

  send(value) {
    this.sent.push(value);
  }
}

function installCustomEventShim() {
  if (globalThis.CustomEvent) return;
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
}

installCustomEventShim();

const noJitterBackoff = createReconnectBackoff({ initial: 1000, factor: 2, max: 5000, jitter: 0 });
assert.equal(noJitterBackoff(0), 1000);
assert.equal(noJitterBackoff(1), 2000);
assert.equal(noJitterBackoff(2), 4000);
assert.equal(noJitterBackoff(3), 5000);

let scheduled = [];
const states = [];
FakeWebSocket.instances = [];

const client = new ReconnectingWebSocketClient({
  urlFactory: () => "wss://example.test/ws",
  WebSocketClass: FakeWebSocket,
  backoff: noJitterBackoff,
  setTimeout: (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  },
  clearTimeout: () => {}
});
client.addEventListener("state", event => states.push(event.detail));

client.connect();
assert.equal(states.at(-1).state, SOCKET_STATES.CONNECTING);
assert.equal(FakeWebSocket.instances.length, 1);

FakeWebSocket.instances[0].open();
assert.equal(states.at(-1).state, SOCKET_STATES.CONNECTED);

FakeWebSocket.instances[0].failClose(1006);
assert.equal(states.at(-1).state, SOCKET_STATES.RECONNECTING);
assert.equal(states.at(-1).delay, 1000);
assert.equal(scheduled.length, 1);

scheduled.shift().fn();
assert.equal(FakeWebSocket.instances.length, 2);
FakeWebSocket.instances[1].open();
assert.equal(states.at(-1).state, SOCKET_STATES.CONNECTED);

client.updateLatestPosition({ lat: 40, lng: -3 });
let resentPosition = null;
client.addEventListener("resend-position", event => {
  resentPosition = event.detail;
});
FakeWebSocket.instances[1].failClose(1006);
scheduled.shift().fn();
FakeWebSocket.instances[2].open();
assert.deepEqual(resentPosition, { lat: 40, lng: -3 });

client.close("manual-test");
assert.equal(client.state, SOCKET_STATES.CLOSED);
const scheduledBeforeManualClose = scheduled.length;
FakeWebSocket.instances[2].failClose(1000);
assert.equal(scheduled.length, scheduledBeforeManualClose);

const limited = new ReconnectingWebSocketClient({
  urlFactory: () => "wss://example.test/ws",
  WebSocketClass: FakeWebSocket,
  backoff: noJitterBackoff,
  maxAttempts: 0,
  setTimeout: (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  },
  clearTimeout: () => {}
});
let limitedState = null;
limited.addEventListener("state", event => {
  limitedState = event.detail.state;
});
limited.connect();
FakeWebSocket.instances.at(-1).failClose(1006);
assert.equal(limitedState, SOCKET_STATES.OFFLINE);

console.log("websocket-client tests passed");
