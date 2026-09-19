/* Sidebar UI helpers: context menu and in-sidebar dialogs. */
import { h } from "./dom.js";

export { h, letterFor, setIcon, syncChildren } from "./dom.js";

/* ---------- Context menu ---------- */

const menuEl = document.getElementById("menu");

export function hideMenu() {
  menuEl.hidden = true;
  menuEl.replaceChildren();
}

/** items: [{label, run, danger?, disabled?} | "-"]; `after` runs once an item finishes. */
export function showMenu(items, x, y, after = () => {}) {
  const nodes = items.map((item) =>
    item === "-"
      ? h("hr")
      : h(
          "button",
          {
            className: item.danger ? "danger" : "",
            disabled: !!item.disabled,
            onclick: async () => {
              hideMenu();
              try {
                await item.run();
              } finally {
                after();
              }
            },
          },
          item.label
        )
  );
  menuEl.replaceChildren(...nodes);
  menuEl.hidden = false;
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
  menuEl.querySelector("button:not(:disabled)")?.focus();
}

document.addEventListener("mousedown", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
});
window.addEventListener("blur", hideMenu);

/* ---------- Modal dialog ---------- */

const dialogEl = document.getElementById("dialog");

/** Show `form` in the modal. Resolves with whatever `close(value)` is called with. */
export function openDialog(build) {
  hideMenu();
  return new Promise((resolve) => {
    const close = (value) => {
      dialogEl.hidden = true;
      dialogEl.replaceChildren();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    dialogEl.replaceChildren(build(close));
    dialogEl.hidden = false;
    dialogEl.querySelector("input, select, button")?.focus();
  });
}

dialogEl.addEventListener("mousedown", (e) => {
  if (e.target === dialogEl) dialogEl.querySelector("[data-cancel]")?.click();
});

export function confirmDialog(title, text, okLabel) {
  return openDialog((close) =>
    h(
      "form",
      { className: "dialog-card", onsubmit: (e) => (e.preventDefault(), close(true)) },
      h("h2", {}, title),
      h("p", { className: "hint" }, text),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(false) }, "Cancel"),
        h("button", { type: "submit", className: "primary danger" }, okLabel)
      )
    )
  );
}
