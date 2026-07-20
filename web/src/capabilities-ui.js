const ROOM_STATE_PREFIX = "lastseen:";

const managedControls = [
  {
    selector: "#set-meeting-here",
    capability: "canSetMeetingPoint",
    hiddenText: "Solo el creador puede fijar el punto de encuentro."
  },
  {
    selector: "#set-meeting-map",
    capability: "canSetMeetingPoint",
    hiddenText: "Solo el creador puede fijar el punto de encuentro."
  },
  {
    selector: "#set-perimeter-map",
    capability: "canSetPerimeter",
    hiddenText: "Solo el creador puede dibujar perímetros."
  },
  {
    selector: "#perimeter-radius",
    capability: "canSetPerimeter",
    hiddenText: "Solo el creador puede elegir el radio del perímetro."
  },
  {
    selector: 'label[for="perimeter-radius"]',
    capability: "canSetPerimeter",
    hiddenText: ""
  }
];

applyStoredCapabilities();
window.addEventListener("lastseen:join-contract", event => {
  applyCapabilities(event.detail?.contract?.capabilities || {}, event.detail?.contract?.role || "participant");
});
document.addEventListener("DOMContentLoaded", applyStoredCapabilities);

function applyStoredCapabilities() {
  const roomID = getRoomID();
  if (!roomID) return;

  const state = readRoomState(roomID);
  if (!state.capabilities) return;
  applyCapabilities(state.capabilities, state.role || "participant");
}

function applyCapabilities(capabilities, role) {
  const normalized = normalizeCapabilities(capabilities);
  const isCreator = role === "creator";

  for (const item of managedControls) {
    const allowed = Boolean(normalized[item.capability]);
    const element = document.querySelector(item.selector);
    if (!element) continue;

    element.hidden = !allowed;
    element.disabled = !allowed;
    element.setAttribute("aria-disabled", String(!allowed));
    element.dataset.lastseenCapability = item.capability;
    element.title = allowed ? "" : item.hiddenText;
  }

  document.body?.classList.toggle("role-creator", isCreator);
  document.body?.classList.toggle("role-participant", !isCreator);
  document.body?.setAttribute("data-lastseen-role", role || "participant");

  renderCapabilityHint(normalized, role);
}

function renderCapabilityHint(capabilities, role) {
  const status = document.querySelector("#safety-status");
  if (!status) return;

  const canEditSafety = Boolean(capabilities.canSetMeetingPoint || capabilities.canSetPerimeter);
  if (canEditSafety) {
    if (/Solo el creador|permisos/.test(status.textContent || "")) {
      status.textContent = "Puedes fijar punto de encuentro y perímetro para la sala.";
    }
    return;
  }

  if (role === "participant") {
    status.textContent = "Puedes ver el punto de encuentro y el perímetro. Solo el creador puede modificarlos.";
  }
}

function normalizeCapabilities(value) {
  const capabilities = value && typeof value === "object" ? value : {};
  return {
    canViewRoom: Boolean(capabilities.canViewRoom),
    canShareLocation: Boolean(capabilities.canShareLocation),
    canSendSOS: Boolean(capabilities.canSendSOS),
    canSendPanic: Boolean(capabilities.canSendPanic),
    canWakeParticipants: Boolean(capabilities.canWakeParticipants),
    canSetMeetingPoint: Boolean(capabilities.canSetMeetingPoint),
    canSetPerimeter: Boolean(capabilities.canSetPerimeter),
    canUpdateTTL: Boolean(capabilities.canUpdateTTL),
    canEndRoom: Boolean(capabilities.canEndRoom)
  };
}

function readRoomState(roomID) {
  try {
    return JSON.parse(localStorage.getItem(`${ROOM_STATE_PREFIX}${roomID}:state`) || "{}") || {};
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
