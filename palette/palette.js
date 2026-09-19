/* global ArcFox */
/* Arc-style command bar, shown as the page of a new tab (Cmd/Ctrl+T, New Tab).
   Picking something navigates this tab; Esc closes it. */
import { h, setIcon } from "../sidebar/dom.js";
import { resolve, engineName, runSearch, switchToTab, suggestFor, topSiteItems } from "../sidebar/suggest.js";

// Filled in at startup from the tab this page lives in.
let windowId = null;
let ownTabId = null;

const input = document.getElementById("q");
const list = document.getElementById("list");
const hint = document.getElementById("hint");

let items = [];
let itemsFor = "";
let selected = 0;
let token = 0;
let engine = "the web";
let closing = false;

// Extensions may not open Firefox's own pages (about:config, about:keyboard...).
const isFirefoxPage = (url) => /^about:/i.test(url || "") && !/^about:(blank|newtab|home)$/i.test(url);

/** Navigate this tab to `target` ({url} or {search}). */
async function open(target) {
  if (isFirefoxPage(target.url)) {
    hint.textContent = navigator.platform.startsWith("Mac")
      ? "Firefox pages open from Firefox\u2019s address bar: press \u2318L"
      : "Firefox pages open from Firefox\u2019s address bar: press Ctrl+L";
    hint.classList.add("warn");
    throw new Error("firefox page");
  }
  if (target.url) await browser.tabs.update(ownTabId, { url: target.url });
  if (target.search) await runSearch(ownTabId, target.search);
}

/** Close this tab (Arc's "cancel"), unless it's the window's last one. */
async function cancel() {
  if ((await browser.tabs.query({ windowId })).length > 1) await browser.tabs.remove(ownTabId);
}

async function run(item) {
  if (closing) return;
  closing = true;
  try {
    if (item.tab) {
      // Switching to an existing tab makes this blank one pointless.
      await switchToTab(item.tab, windowId);
      await cancel();
    } else {
      await open(item.target);
    }
  } catch (err) {
    if (err.message !== "firefox page") console.error("Arc: command bar action failed", err);
    closing = false;
  }
}

const SUBS = { go: "Open", tab: "Switch to Tab" };

function render() {
  list.replaceChildren(
    ...items.map((item, i) => {
      const icon = h("span", { className: "icon" });
      if (item.kind === "tab" || item.kind === "history") setIcon(icon, item.icon, item.url);
      else icon.textContent = item.kind === "search" ? "⌕" : "↗";
      const side =
        item.kind === "tab"
          ? h("span", { className: "side" }, "Switch to Tab", h("span", { className: "key" }, "→"))
          : item.kind === "history" && item.sub
            ? null
            : h("span", { className: "side" }, item.kind === "search" ? `Search ${engine}` : SUBS[item.kind] || "");
      return h(
        "li",
        {
          className: i === selected ? "selected" : "",
          onmouseenter: () => {
            selected = i;
            for (const [j, row] of [...list.children].entries()) row.classList.toggle("selected", j === i);
          },
          onmousedown: (e) => {
            e.preventDefault();
            run(item);
          },
        },
        h("span", { className: "chip" }, icon),
        h(
          "span",
          { className: "label" },
          item.label,
          item.kind === "history" && item.sub ? h("span", { className: "domain" }, ` — ${item.sub}`) : null
        ),
        side
      );
    })
  );
}

async function update() {
  const text = input.value.trim();
  const mine = ++token;
  const next = text ? await suggestFor(text, { max: 8 }) : await topSiteItems({ max: 6 });
  if (mine !== token) return;
  items = next;
  itemsFor = text;
  selected = 0;
  hint.textContent = text ? `Search ${engine}` : "";
  hint.classList.remove("warn");
  render();
}

let debounce = 0;
input.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(update, 50);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    render();
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const text = input.value.trim();
    // Suggestions may lag behind fast typing; fall back to the raw text.
    if (items[selected] && itemsFor === text) run(items[selected]);
    else if (text) run({ target: resolve(text) });
  } else if (e.key === "Tab" && input.value.trim()) {
    // Arc: Tab searches with the default engine.
    e.preventDefault();
    run({ target: { search: input.value.trim() } });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});

// Keep the field focused whenever the page gets focus (e.g. switching back).
window.addEventListener("focus", () => {
  if (document.activeElement !== input) input.focus();
});

(async () => {
  const self = await browser.tabs.getCurrent();
  ownTabId = self.id;
  windowId = self.windowId;
  input.focus();
  // Tint with the space color of the window the bar belongs to.
  const state = await ArcFox.getState();
  const spaceId = await ArcFox.getWindowSpace(windowId, state);
  const space = state.spaces.find((x) => x.id === spaceId);
  document.documentElement.style.setProperty("--space", ArcFox.COLORS[space.color] || ArcFox.COLORS.purple);
  document.title = "New Tab";
  engine = await engineName();
  input.focus();
  update();
})();
