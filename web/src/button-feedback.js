const FEEDBACK_CLASS = "is-pressing";
const ACTIVE_CLASS = "is-active-action";
const ACTIVE_BUTTON_IDS = new Set(["set-meeting-map", "set-perimeter-map"]);

installButtonFeedback();
installMapActionFeedback();

function installButtonFeedback() {
  document.addEventListener("pointerdown", event => {
    const button = event.target?.closest?.("button, .button-like");
    if (!button || button.disabled) return;

    button.classList.remove(FEEDBACK_CLASS);
    // Force style recalculation so repeated taps replay the animation.
    void button.offsetWidth;
    button.classList.add(FEEDBACK_CLASS);
  }, { passive: true });

  document.addEventListener("pointerup", clearPressing, { passive: true });
  document.addEventListener("pointercancel", clearPressing, { passive: true });
  document.addEventListener("mouseleave", clearPressing, { passive: true });

  document.addEventListener("animationend", event => {
    const button = event.target?.closest?.("button, .button-like");
    if (button) button.classList.remove(FEEDBACK_CLASS);
  });
}

function installMapActionFeedback() {
  document.addEventListener("click", event => {
    const button = event.target?.closest?.("button");
    if (!button || !ACTIVE_BUTTON_IDS.has(button.id)) return;

    clearActiveMapActions();
    button.classList.add(ACTIVE_CLASS);
    button.setAttribute("aria-pressed", "true");
  }, { capture: true });

  document.addEventListener("click", event => {
    const map = event.target?.closest?.("#map");
    if (map) clearActiveMapActions();
  }, { capture: true });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") clearActiveMapActions();
  });
}

function clearPressing() {
  document.querySelectorAll(`.${FEEDBACK_CLASS}`).forEach(button => button.classList.remove(FEEDBACK_CLASS));
}

function clearActiveMapActions() {
  document.querySelectorAll(`.${ACTIVE_CLASS}`).forEach(button => {
    button.classList.remove(ACTIVE_CLASS);
    button.removeAttribute("aria-pressed");
  });
}
