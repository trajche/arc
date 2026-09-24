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

// Re-rendering the list moves fresh rows under a resting cursor, which fires
// mouseenter and would drag the selection back to whatever the mouse is over.
// Hover only counts once the mouse has actually moved again.
let pointerActive = true;
document.addEventListener("mousemove", () => {
  pointerActive = true;
});

let items = [];
let itemsFor = "";
let selected = 0;
let token = 0;
let engine = "the web";
let closing = false;

// Extensions may not open Firefox's own pages (about:config, about:keyboard...).
const isFirefoxPage = (url) => /^about:/i.test(url || "") && !/^about:(blank|newtab|home)$/i.test(url);

/** Open a connection to `url`'s host while the user is still reading the list.
 *  DNS and TLS are most of the wait on a first visit to a site. */
const warmed = new Set();
function preconnect(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (!/^https?:$/.test(new URL(origin).protocol) || warmed.has(origin)) return;
  warmed.add(origin);
  document.head.append(h("link", { rel: "preconnect", href: origin }));
}

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

/** What the sidebar should show for this row while the page loads. */
function pendingLabel(item) {
  const url = item.target?.url;
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "") || url;
    } catch {
      return url;
    }
  }
  return item.target?.search ? `Search ${engine}` : "Loading…";
}

async function run(item) {
  if (closing) return;
  closing = true;
  await ready; // ownTabId/windowId may still be resolving
  try {
    if (!item.tab) {
      const label = pendingLabel(item);
      // Tell the sidebar now: Firefox reports the new URL only once the page
      // commits, and until then the row would still read "New Tab".
      browser.runtime.sendMessage({ type: "arcfox:navigating", tabId: ownTabId, label }).catch(() => {});
      // ...and say so here too: this page stays up until the new one paints.
      document.body.classList.add("busy");
      hint.textContent = item.target?.search ? `Searching ${engine}…` : `Opening ${label}…`;
      hint.classList.remove("warn");
    }
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
            if (!pointerActive) return;
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
  if (items[0]?.target?.url) preconnect(items[0].target.url);
  hint.textContent = text ? `Search ${engine}` : "";
  hint.classList.remove("warn");
  render();
}

let debounce = 0;
input.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(update, 50);
});

// On the document, not the field: the mouse may have moved focus away (a
// click in the page, a hovered row), and the arrows have to keep working.
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    pointerActive = false; // the keyboard has the selection now
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
  } else if (document.activeElement !== input && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
    // Typing anywhere goes back into the field, with the character kept.
    input.focus();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
  // The command bar is already here. Arc owns Cmd/Ctrl+T once the setup has
  // cleared Firefox's own (reserved) shortcut; until then, at least keep the
  // keypress from reaching this page's field.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// Keep the field focused whenever the page gets focus (e.g. switching back).
window.addEventListener("focus", () => {
  if (document.activeElement !== input) input.focus();
});

// Focus before anything else: typing must land in the field, not be lost
// while the tab, space and search engine are looked up.
input.focus();
document.title = "New Tab";

// Typing can beat this; run() waits on it before acting.
const ready = (async () => {
  const self = await browser.tabs.getCurrent();
  ownTabId = self.id;
  windowId = self.windowId;
  if (document.activeElement !== input) input.focus();
  update(); // frequent sites, before the slower lookups

  // Tint with the space color of the window the bar belongs to.
  const state = await ArcFox.getState();
  const spaceId = await ArcFox.getWindowSpace(windowId, state);
  const space = state.spaces.find((x) => x.id === spaceId);
  const tint = ArcFox.COLORS[space.color] || ArcFox.COLORS.purple;
  document.documentElement.style.setProperty("--space", tint);
  try {
    localStorage.setItem("arc:space-tint", tint);
  } catch {
    // nothing to cache with: the next new tab just starts on the default
  }

  // The engine name only fills in the "Search <engine>" hint.
  engine = await engineName();
  if (!input.value.trim()) return;
  hint.textContent = `Search ${engine}`;
  render();
})();
