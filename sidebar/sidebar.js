/* global ArcFox */
import { h, setIcon, syncChildren, showMenu, hideMenu } from "./ui.js";
import { createAddressBar } from "./address.js";
import { createSpacesBar } from "./spaces.js";

const TAB_MIME = "application/x-arcfox-tab";
const ITEM_MIME = "application/x-arcfox-item";

const $ = (id) => document.getElementById(id);
const els = {
  favorites: $("favorites"),
  spaceHead: $("space-head"),
  spaceIcon: $("space-icon"),
  spaceName: $("space-name"),
  pinned: $("pinned"),
  today: $("today"),
  newTab: $("new-tab"),
  clear: $("clear"),
  newTabLink: $("new-tab-link"),
};

const state = {
  windowId: null,
  private: false,
  spaceId: null,
  spaces: [],
  favorites: [], // this space's favorites (its container's list)
  favKey: "favorites",
  pins: [], // pinned items of the current space
  icons: {},
  hideFavHint: false,
  bound: new Map(), // itemId -> tab
  tabItem: new Map(), // tabId -> itemId
  tabSpace: new Map(), // tabId -> spaceId
  badges: new Map(), // tabId -> badges other extensions put on it
  tabs: [], // this window, sorted by index
};

const HIDE_FAV_HINT = "hideFavoritesHint"; // storage.local, per device

const tileEls = new Map();
const pinEls = new Map();
const tabEls = new Map();
let dragging = false;

const space = () => state.spaces.find((s) => s.id === state.spaceId);
const activeTab = () => state.tabs.find((t) => t.active) || null;
const tabById = (id) => state.tabs.find((t) => t.id === id);

function spaceOf(tab) {
  const s = state.tabSpace.get(tab.id);
  return s && state.spaces.some((x) => x.id === s) ? s : state.spaceId;
}

const PALETTE_URL = browser.runtime.getURL("palette/palette.html");

/** The command bar already open in this space, if any. */
function openCommandBar() {
  return state.tabs.find(
    (t) => !t.hidden && t.url?.startsWith(PALETTE_URL) && (state.private || spaceOf(t) === state.spaceId)
  );
}

function newTabInSpace(url) {
  // One command bar at a time: a second Cmd+T just goes back to it.
  if (!url) {
    const open = openCommandBar();
    if (open) return browser.tabs.update(open.id, { active: true });
  }
  // New tabs open at the top of the space's list, like Arc.
  const create = state.private
    ? browser.tabs.create({ windowId: state.windowId, active: true, ...(url ? { url } : {}) })
    : ArcFox.topIndexOfSpace(state.windowId, state.spaceId).then((index) =>
        ArcFox.createTabInSpace(state.windowId, space(), { url, index })
      );
  return create.then((tab) => {
    schedule(true);
    return tab;
  });
}

/* ---------- Refresh scheduling ---------- */

let scanDirty = true;
let frame = 0;
let running = false;
let again = false;

function schedule(scan = false) {
  if (scan) scanDirty = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    refresh();
  });
}

async function refresh() {
  if (state.windowId === null) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const scan = scanDirty;
      scanDirty = false;
      const [st, icons, allTabs, prefs, badges] = await Promise.all([
        ArcFox.getState(),
        ArcFox.getIconCache(),
        browser.tabs.query({}).then((tabs) => tabs.filter((t) => !removedTabs.has(t.id))),
        browser.storage.local.get([HIDE_FAV_HINT, PINS_COLLAPSED]),
        ArcFox.getBadges(),
      ]);
      state.badges = badges;
      state.hideFavHint = !!prefs[HIDE_FAV_HINT];
      collapsed = prefs[PINS_COLLAPSED] || {};
      if (scan) {
        const result = await ArcFox.scanTabs(allTabs, st);
        state.tabItem = result.tabItem;
        state.tabSpace = result.tabSpace;
      }
      state.spaceId = state.private ? null : await ArcFox.getWindowSpace(state.windowId, st);
      state.spaces = st.spaces;
      // Favorites of this space's container (Arc: per profile).
      state.favKey = ArcFox.favKey(st.spaces.find((x) => x.id === state.spaceId));
      state.favorites = state.private ? [] : st.favLists.get(state.favKey) || [];
      state.pins = state.private ? [] : st.pins.get(state.spaceId) || [];
      state.icons = icons;

      const itemIds = new Set([...st.favorites, ...[...st.pins.values()].flat()].map((i) => i.id));
      const byId = new Map(allTabs.map((t) => [t.id, t]));
      state.bound = new Map();
      for (const [tabId, itemId] of state.tabItem) {
        const tab = byId.get(tabId);
        if (tab && itemIds.has(itemId)) state.bound.set(itemId, tab);
        else state.tabItem.delete(tabId);
      }
      for (const tabId of state.tabSpace.keys()) if (!byId.has(tabId)) state.tabSpace.delete(tabId);
      state.tabs = allTabs.filter((t) => t.windowId === state.windowId).sort((a, b) => a.index - b.index);
      if (!dragging && !renaming) render();
    } while (again);
  } finally {
    running = false;
  }
}

/* ---------- Rendering ---------- */

function render() {
  document.body.classList.remove("booting");
  if (state.private) return renderPrivate();
  const sp = space();
  const color = ArcFox.COLORS[sp?.color] || ArcFox.COLORS.purple;
  document.documentElement.style.setProperty("--space", color);
  // New tabs read this to paint the right tint on their first frame.
  try {
    if (localStorage.getItem("arc:space-tint") !== color) localStorage.setItem("arc:space-tint", color);
  } catch {
    // no storage here: new tabs just start on the default color
  }
  els.spaceIcon.textContent = sp?.icon || "";
  els.spaceIcon.hidden = !sp?.icon;
  els.spaceName.textContent = sp?.name || "";

  applyCollapsed();
  renderFavorites();
  renderPinned();
  renderToday();
  applySelection();
  spacesBar.render(state);
  address.update(activeTab());

  const tab = activeTab();
  $("back").disabled = !tab;
  $("forward").disabled = !tab;
}

function renderFavorites() {
  const activeId = activeTab()?.id;
  const nodes = state.favorites.map((fav) => {
    let el = tileEls.get(fav.id);
    if (!el) {
      el = h("button", { className: "tile", draggable: true, dataset: { item: fav.id } }, h("span", { className: "icon" }));
      tileEls.set(fav.id, el);
    }
    const tab = state.bound.get(fav.id);
    el.classList.toggle("open", !!tab);
    el.classList.toggle("active", !!tab && tab.id === activeId);
    el.title = tab?.title || fav.title;
    setIcon(el.firstChild, tab?.favIconUrl || state.icons[fav.id] || fav.icon, fav.url);
    return el;
  });
  prune(tileEls, state.favorites.map((f) => f.id));
  const empty = nodes.length === 0;
  els.favorites.classList.toggle("empty", empty);
  // Dismissed hint: the zone stays hidden and only shows up while dragging.
  els.favorites.classList.toggle("collapsed", empty && state.hideFavHint);
  syncChildren(els.favorites, empty ? favHint : nodes);
}

const SVG_NS = "http://www.w3.org/2000/svg";

const closeIcon = () => lucide(LUCIDE.x);

/** favicon, mute, title, badges, close: the parts fillRow() updates. */
const rowParts = () => [
  h("span", { className: "favicon" }),
  h("button", { className: "icon-btn audio" }),
  h("span", { className: "title" }),
  h("span", { className: "badges" }),
  h("button", { className: "icon-btn close", title: "Close tab" }, closeIcon()),
];

function makeRow(dataset) {
  return h("li", { className: "tab", draggable: true, dataset }, ...rowParts());
}

/** Firefox split view: one row, one half per tab (like Arc). */
function makeSplitRow() {
  return h("li", { className: "tab split" });
}

function fillRow(el, tab, { title, url, icon }) {
  const [favicon, audio, titleEl, badgesEl] = el.children;
  el.classList.toggle("active", !!tab?.active);
  el.classList.toggle("discarded", !!tab?.discarded);
  el.classList.toggle("loading", tab?.status === "loading" && !tab.discarded);
  if (titleEl.textContent !== title) titleEl.textContent = title;
  el.title = url ? `${title}\n${url}` : title;
  setIcon(favicon, icon, url);
  const muted = !!tab?.mutedInfo?.muted;
  audio.hidden = !(tab?.audible || muted);
  const want = muted ? "off" : "on";
  if (audio.dataset.state !== want) {
    audio.dataset.state = want;
    audio.replaceChildren(lucide(muted ? LUCIDE.volumeOff : LUCIDE.volume));
  }
  audio.title = muted ? "Unmute tab" : "Mute tab";
  fillBadges(badgesEl, (tab && state.badges.get(tab.id)) || []);
}

/** Badges other extensions set on a tab (see "Tab badges" in background.js). */
function fillBadges(el, badges) {
  const key = JSON.stringify(badges);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(
    ...badges.map((b) =>
      h("span", { className: "badge", title: b.title, style: b.color ? { "--badge": b.color } : undefined }, b.label)
    )
  );
}

/** Lucide icons: 24-grid, 2px round strokes. https://lucide.dev (ISC) */
const LUCIDE = {
  volume:
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6m3.364 3.364a9 9 0 0 0 0-12.728",
  volumeOff:
    "M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298zm5.5 9.798l5-5m-5 0l5 5",
  x: "M18 6L6 18M6 6l12 12",
};

function lucide(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function svgIcon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

const FOLDER_CLOSED = "M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5h5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z";
const FOLDER_OPEN =
  "M1.75 11.75v-7.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5h4.5a1.5 1.5 0 0 1 1.5 1.5v1M1.75 11.75l1.7-4.6a1.2 1.2 0 0 1 1.1-.8h9.2a.8.8 0 0 1 .75 1.1l-1.6 4.3a1.2 1.2 0 0 1-1.1.8H3.25a1.5 1.5 0 0 1-1.5-1.5";

function pinRow(item, parent) {
  let el = pinEls.get(item.id);
  if (!el || el.classList.contains("folder")) {
    el = makeRow({ item: item.id });
    el.classList.add("item");
    pinEls.set(item.id, el);
  }
  el.dataset.sel = `i:${item.id}`;
  el.dataset.parent = parent || "";
  el.classList.toggle("child", !!parent);
  const tab = state.bound.get(item.id);
  el.classList.toggle("open", !!tab);
  // Arc shows the saved title for pinned items; fall back to the live tab title.
  fillRow(el, tab, {
    title: item.title || tab?.title || item.url,
    url: tab?.url || item.url,
    icon: tab?.favIconUrl || state.icons[item.id] || item.icon,
  });
  return el;
}

function folderRow(folder) {
  let el = pinEls.get(folder.id);
  if (!el || !el.classList.contains("folder")) {
    el = h(
      "li",
      { className: "tab folder", draggable: true, dataset: { item: folder.id } },
      h("span", { className: "favicon folder-icon" }),
      h("span", { className: "title" })
    );
    pinEls.set(folder.id, el);
  }
  el.dataset.sel = `i:${folder.id}`;
  el.dataset.parent = "";
  el.classList.toggle("expanded", !!folder.open);
  const icon = el.querySelector(".folder-icon");
  const shape = folder.open ? "open" : "closed";
  if (icon.dataset.shape !== shape) {
    icon.dataset.shape = shape;
    icon.replaceChildren(svgIcon(folder.open ? FOLDER_OPEN : FOLDER_CLOSED));
  }
  const title = el.querySelector(".title");
  if (title && title.textContent !== folder.name) title.textContent = folder.name;
  el.title = folder.name;
  return el;
}

function renderPinned() {
  const folderIds = new Set(state.pins.filter(ArcFox.isFolder).map((f) => f.id));
  const nodes = [];
  for (const item of state.pins) {
    if (item.parent && folderIds.has(item.parent)) continue; // rendered under its folder
    if (ArcFox.isFolder(item)) {
      nodes.push(folderRow(item));
      if (item.open) for (const child of state.pins) if (child.parent === item.id) nodes.push(pinRow(child, item.id));
    } else {
      nodes.push(pinRow(item, ""));
    }
  }
  prune(pinEls, state.pins.map((i) => i.id));
  syncChildren(els.pinned, nodes);
  if (pendingRename && pinEls.has(pendingRename)) {
    const id = pendingRename;
    pendingRename = null;
    startRename(id);
  }
}

// splitViewId is -1 (tabs.SPLIT_VIEW_ID_NONE) when the tab isn't in a Firefox split view.
/**
 * A blank "New Tab": Firefox/Arc new-tab pages, the command bar, or an
 * about:blank tab that isn't on its way somewhere — a tab opened from a link
 * starts blank too, and that one should show as loading, not as "New Tab".
 */
const isBlankTab = (tab) =>
  ArcFox.isNewTabUrl(tab.url) || ((!tab.url || tab.url === "about:blank") && tab.status !== "loading");

const inSplit = (tab) => tab.splitViewId !== undefined && tab.splitViewId !== -1;

// Firefox clears favIconUrl while a tab navigates, which would swap the icon
// for a letter tile and back on every load. Keep the last one for as long as
// the tab stays on the same site.
const lastIcon = new Map(); // tabId -> { icon, origin }

function iconFor(tab) {
  let origin = "";
  try {
    origin = new URL(tab.url || "").origin;
  } catch {
    // about:, blank, or a URL Firefox hasn't reported yet
  }
  if (tab.favIconUrl) {
    lastIcon.set(tab.id, { icon: tab.favIconUrl, origin });
    return tab.favIconUrl;
  }
  const kept = lastIcon.get(tab.id);
  if (kept && (kept.origin === origin || !origin)) return kept.icon;
  lastIcon.delete(tab.id);
  return null;
}

function tabEl(tab, make) {
  let el = tabEls.get(tab.id);
  if (!el || el.matches("li") !== (make === makeRow)) {
    el = make === makeRow ? makeRow({ tab: tab.id }) : h("span", { className: "half", draggable: true, dataset: { tab: tab.id } }, ...rowParts());
    tabEls.set(tab.id, el);
  }
  el.dataset.sel = `t:${tab.id}`;
  // Blank tabs (Cmd+T, command bar) look like the "+ New Tab" row — unless the
  // command bar has just sent one somewhere.
  const pending = pendingNav.get(tab.id);
  const blank = !pending && isBlankTab(tab);
  el.classList.toggle("blank", blank);
  const loadingTitle = tab.status === "loading" ? "Loading…" : tab.url;
  const title = blank ? "New Tab" : pending?.label || tab.title || loadingTitle;
  fillRow(el, tab, { title, url: pending ? "" : tab.url, icon: pending ? null : iconFor(tab) });
  if (blank) el.classList.remove("loading"); // a blank row never spins
  if (pending) el.classList.add("loading"); // ...but a tab on its way does
  if (blank) {
    const box = el.querySelector(".favicon");
    if (box.dataset.src !== "plus") {
      box.dataset.src = "plus";
      box.replaceChildren(h("span", { className: "plus" }, "+"));
    }
  }
  return el;
}

function renderToday() {
  const tabs = state.tabs.filter(
    (t) =>
      !state.tabItem.has(t.id) &&
      !doomedTabs.has(t.id) &&
      (preSwapTabs.has(t.id) || state.private || spaceOf(t) === state.spaceId)
  );
  // A tab Firefox just made sits at the end of its list and has no space yet;
  // draw it where Arc is about to put it so the row never moves.
  tabs.sort((a, b) => (preSwapTabs.has(b.id) ? 1 : 0) - (preSwapTabs.has(a.id) ? 1 : 0));
  const all = tabs;
  // The "+ New Tab" button only shows while Today is empty; otherwise Cmd+T.
  els.newTab.hidden = all.length > 0;
  // A lone blank tab has nothing to close into: no ✕ on it.
  els.today.classList.toggle("only-blank", all.length === 1 && isBlankTab(all[0]));
  const nodes = [];
  const splitKeys = new Set();
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const next = tabs[i + 1];
    if (inSplit(tab) && next && next.splitViewId === tab.splitViewId) {
      const key = `split:${tab.splitViewId}`;
      splitKeys.add(key);
      let row = tabEls.get(key);
      if (!row) tabEls.set(key, (row = makeSplitRow()));
      // Drops before/after the row use its first/last tab.
      row.dataset.tab = tab.id;
      row.dataset.lastTab = next.id;
      row.classList.toggle("active", tab.active || next.active);
      syncChildren(row, [tabEl(tab, null), tabEl(next, null)]);
      nodes.push(row);
      i++;
    } else {
      nodes.push(tabEl(tab, makeRow));
    }
  }
  prune(tabEls, [...state.tabs.map((t) => t.id), ...splitKeys]);
  syncChildren(els.today, nodes);
}

function prune(map, keep) {
  const ids = new Set(keep);
  for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
}

const favHint = [
  h("span", { className: "fav-hint-text" }, "Drag tabs here to add Favorites"),
  h("span", { className: "fav-drop-text" }, "Drop to add to Favorites"),
  h(
    "button",
    {
      className: "icon-btn fav-hint-close",
      title: "Hide (drag a tab here any time to add a favorite)",
      onclick: () => browser.storage.local.set({ [HIDE_FAV_HINT]: true }),
    },
    closeIcon()
  ),
];

/** Private window: just the tab list (Arc's Incognito sidebar). */
function renderPrivate() {
  document.body.classList.remove("booting");
  document.documentElement.style.setProperty("--space", ArcFox.COLORS.purple);
  els.spaceName.textContent = "Private window";
  els.spaceIcon.hidden = true;
  renderToday();
  applySelection();
  address.update(activeTab());
  $("back").disabled = !activeTab();
  $("forward").disabled = !activeTab();
}

/* ---------- Modules ---------- */

const address = createAddressBar({
  windowId: () => state.windowId,
  activeTab,
  newTab: newTabInSpace,
});

const spacesBar = createSpacesBar({
  el: $("spaces"),
  windowId: () => state.windowId,
  spaceId: () => state.spaceId,
  refresh: () => schedule(true),
  accepts: (e) => e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(ITEM_MIME),
  onDrop: async (spaceId, dt) => {
    const itemId = dt.getData(ITEM_MIME);
    if (itemId) await ArcFox.moveItem(itemId, ArcFox.pinKey(spaceId));
    else {
      const data = readTabData(dt);
      if (data) await ArcFox.moveTabToSpace(data.tabId, spaceId);
    }
    schedule(true);
  },
});

/* ---------- Toolbar ---------- */

$("back").addEventListener("click", () => activeTab() && browser.tabs.goBack(activeTab().id).catch(() => {}));
$("forward").addEventListener("click", () => activeTab() && browser.tabs.goForward(activeTab().id).catch(() => {}));
$("reload").addEventListener("click", (e) => {
  const tab = activeTab();
  if (tab) browser.tabs.reload(tab.id, { bypassCache: e.shiftKey });
});

/** Close a tab; closing the last one of this space leaves a blank tab, so the window stays. */
async function closeTab(tabId) {
  const rest = state.tabs.filter((t) => t.id !== tabId && spaceOf(t) === state.spaceId);
  if (!rest.length) await newTabInSpace();
  await browser.tabs.remove(tabId);
}

/* ---------- Selection (Shift/Cmd-click), like Arc ---------- */

const selection = new Set(); // "i:<itemId>" (pinned items, folders) / "t:<tabId>" (tabs)
let anchor = null;
let pendingRename = null;
const isMac = navigator.platform.startsWith("Mac");

function applySelection() {
  for (const el of document.querySelectorAll("[data-sel]")) el.classList.toggle("selected", selection.has(el.dataset.sel));
}

function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  applySelection();
}

/** Shift = range, Cmd (Ctrl elsewhere) = toggle. Returns true if the click was a selection click. */
function handleSelectClick(e, el) {
  const toggle = isMac ? e.metaKey : e.ctrlKey;
  if (!el?.dataset.sel || !(e.shiftKey || toggle)) {
    clearSelection();
    if (el?.dataset.sel) anchor = el.dataset.sel;
    return false;
  }
  e.preventDefault();
  const key = el.dataset.sel;
  if (e.shiftKey) {
    const keys = [...document.querySelectorAll("#pinned [data-sel], #today [data-sel]")].map((x) => x.dataset.sel);
    const start = anchor ?? (activeTab() && `t:${activeTab().id}`);
    const a = keys.indexOf(start);
    const b = keys.indexOf(key);
    selection.clear();
    if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selection.add(keys[i]);
    else selection.add(key);
  } else {
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    anchor = key;
  }
  applySelection();
  return true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});

const pinById = (id) => state.pins.find((i) => i.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Arc's menu for several selected rows. */
function selectionMenu() {
  const keys = [...selection];
  const itemIds = keys.filter((k) => k.startsWith("i:")).map((k) => k.slice(2)).filter((id) => pinById(id) && !ArcFox.isFolder(pinById(id)));
  const tabIds = keys.filter((k) => k.startsWith("t:")).map((k) => Number(k.slice(2))).filter((id) => tabById(id));
  const links = [...itemIds.map((id) => state.bound.get(id)?.url || pinById(id)?.url), ...tabIds.map((id) => tabById(id).url)].filter(Boolean);
  const openTabs = [...itemIds.map((id) => state.bound.get(id)?.id).filter(Boolean), ...tabIds];
  const n = itemIds.length + tabIds.length;
  return [
    links.length && { label: "Copy Links", run: () => navigator.clipboard.writeText(links.join("\n")) },
    "-",
    n && {
      label: `New Folder with ${plural(n, "Item")}`,
      run: async () => {
        const folder = await ArcFox.createFolder(state.spaceId, { itemIds, tabIds });
        clearSelection();
        pendingRename = folder.id;
      },
    },
    openTabs.length && { label: `Close ${plural(openTabs.length, "Tab")}`, run: () => browser.tabs.remove(openTabs).then(clearSelection) },
    itemIds.length && {
      label: itemIds.length === 1 ? "Remove Pin" : "Remove Pins",
      danger: true,
      run: async () => {
        for (const id of itemIds) await ArcFox.removeItem(id, state.spaceId);
        clearSelection();
      },
    },
  ].filter(Boolean);
}

function folderMenu(folder) {
  const children = state.pins.filter((i) => i.parent === folder.id);
  return [
    { label: "Rename…", run: () => startRename(folder.id) },
    children.length && {
      label: `Open ${plural(children.length, "Tab")}`,
      run: async () => {
        for (const child of children) await ArcFox.openItem(child.id, state.windowId);
      },
    },
    { label: folder.open ? "Collapse" : "Expand", run: () => toggleFolder(folder) },
    "-",
    children.length && { label: "Ungroup", run: () => ArcFox.deleteFolder(folder.id, { keepItems: true }) },
    { label: children.length ? "Delete Folder and Pins" : "Delete Folder", danger: true, run: () => ArcFox.deleteFolder(folder.id, { keepItems: false }) },
  ].filter(Boolean);
}

function toggleFolder(folder) {
  folder.open = !folder.open; // instant feedback, then persist
  renderPinned();
  applySelection();
  return ArcFox.updateFolder(folder.id, { open: folder.open });
}

let renaming = false;

/** Inline rename of a folder row. */
function startRename(folderId) {
  const el = pinEls.get(folderId);
  const folder = pinById(folderId);
  const title = el?.querySelector(".title");
  if (!title || !folder) return;
  renaming = true;
  const input = h("input", { className: "rename", value: folder.name, spellcheck: false });
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renaming = false;
    const name = input.value.trim();
    input.replaceWith(title);
    if (save && name && name !== folder.name) {
      title.textContent = name;
      await ArcFox.updateFolder(folderId, { name });
    }
    schedule(true);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
}

/** What this sidebar shows, in the shape ArcFox.findItem() expects. */
const localState = () => ({
  favLists: new Map([[state.favKey, state.favorites]]),
  pins: new Map([[state.spaceId, state.pins]]),
});

/* ---------- Item menus ---------- */

function itemMenu(itemId) {
  const found = ArcFox.findItem(localState(), itemId);
  if (!found) return [];
  const { item } = found;
  const isFav = ArcFox.isFavKey(found.key);
  const tab = state.bound.get(itemId);
  const moved = tab && tab.url !== item.url;
  return [
    { label: tab ? "Go to Tab" : "Open", run: () => ArcFox.openItem(itemId, state.windowId) },
    { label: "Open in New Tab", run: () => newTabInSpace(item.url) },
    moved && { label: "Back to Saved URL", run: () => ArcFox.resetItem(itemId) },
    moved && ArcFox.isFavoritable(tab.url) && { label: "Save Current URL", run: () => ArcFox.saveCurrentUrl(itemId) },
    { label: "Copy Link", run: () => navigator.clipboard.writeText(item.url) },
    "-",
    isFav
      ? { label: "Pin in This Space", run: () => ArcFox.moveItem(itemId, ArcFox.pinKey(state.spaceId)) }
      : { label: "Move to Favorites", run: () => ArcFox.moveItem(itemId, state.favKey) },
    !isFav && {
      label: "New Folder with This Item",
      run: async () => {
        const folder = await ArcFox.createFolder(state.spaceId, { itemIds: [itemId] });
        pendingRename = folder.id;
      },
    },
    !isFav && item.parent && {
      label: "Remove from Folder",
      run: () => ArcFox.moveItem(itemId, ArcFox.pinKey(state.spaceId), item.parent, { parent: null }),
    },
    tab && { label: "Close Tab", run: () => browser.tabs.remove(tab.id) },
    isFav
      ? { label: "Remove from Favorites", danger: true, run: () => ArcFox.removeItem(itemId, state.spaceId) }
      : { label: "Unpin", danger: true, run: () => ArcFox.removeItem(itemId, state.spaceId) },
  ].filter(Boolean);
}

/* ---------- Clicks ---------- */

els.favorites.addEventListener("click", (e) => {
  const tile = e.target.closest(".tile");
  if (tile) ArcFox.openItem(tile.dataset.item, state.windowId).then(() => schedule(true));
});

for (const zone of [els.favorites, els.pinned]) {
  zone.addEventListener("contextmenu", (e) => {
    const el = e.target.closest("[data-item]");
    if (!el) return;
    e.preventDefault();
    let items;
    if (el.dataset.sel && selection.has(el.dataset.sel) && selection.size > 1) items = selectionMenu();
    else if (ArcFox.isFolder(pinById(el.dataset.item))) items = folderMenu(pinById(el.dataset.item));
    else items = itemMenu(el.dataset.item);
    showMenu(items, e.clientX, e.clientY, () => schedule(true));
  });
}

/* ---------- Space header: collapse pinned, space menu ---------- */

const PINS_COLLAPSED = "pinnedCollapsed"; // storage.local: {spaceId: true}
let collapsed = {};

function applyCollapsed() {
  const isCollapsed = !!collapsed[state.spaceId];
  document.body.classList.toggle("pins-collapsed", isCollapsed);
  els.spaceHead.setAttribute("aria-expanded", String(!isCollapsed));
}

async function toggleCollapsed() {
  collapsed = { ...collapsed, [state.spaceId]: !collapsed[state.spaceId] };
  applyCollapsed();
  await browser.storage.local.set({ [PINS_COLLAPSED]: collapsed });
}

els.spaceHead.addEventListener("click", (e) => {
  if (e.target.closest("#space-more")) return;
  toggleCollapsed();
});

$("space-more").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(spaceMenu(), r.left, r.bottom + 4, () => schedule(true));
});

// Right-click the space name: same menu.
els.spaceHead.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showMenu(spaceMenu(), e.clientX, e.clientY, () => schedule(true));
});

function spaceMenu() {
  return [
    {
      label: "New Folder",
      run: async () => {
        pendingRename = (await ArcFox.createFolder(state.spaceId)).id;
      },
    },
    "-",
    { label: "Import from Arc…", run: () => newTabInSpace(browser.runtime.getURL("import/import.html")) },
    { label: "Welcome & Setup", run: () => newTabInSpace(browser.runtime.getURL("welcome/welcome.html")) },
  ];
}

els.pinned.addEventListener("click", (e) => {
  const row = e.target.closest(".tab");
  if (!row || handleSelectClick(e, row)) return;
  const folder = pinById(row.dataset.item);
  if (ArcFox.isFolder(folder)) {
    toggleFolder(folder);
    return;
  }
  const tab = state.bound.get(row.dataset.item);
  if (e.target.closest(".close")) {
    if (tab) closeTab(tab.id);
  } else if (e.target.closest(".audio")) {
    if (tab) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  } else {
    ArcFox.openItem(row.dataset.item, state.windowId).then(() => schedule(true));
  }
});

els.pinned.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".tab.folder");
  if (row && e.target.closest(".title")) startRename(row.dataset.item);
});

els.pinned.addEventListener("auxclick", (e) => {
  const row = e.target.closest(".tab");
  const tab = row && state.bound.get(row.dataset.item);
  if (tab && e.button === 1) closeTab(tab.id);
});

els.today.addEventListener("click", (e) => {
  const row = e.target.closest("[data-tab]:not(.split)");
  if (handleSelectClick(e, row)) return;
  const tab = row && tabById(Number(row.dataset.tab));
  if (!tab) return;
  if (e.target.closest(".close")) closeTab(tab.id);
  else if (e.target.closest(".audio")) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  else browser.tabs.update(tab.id, { active: true });
});

els.today.addEventListener("auxclick", (e) => {
  const row = e.target.closest("[data-tab]:not(.split)");
  if (row && e.button === 1) closeTab(Number(row.dataset.tab));
});

// Arc's tab menu items ("Add to Favorites / Pin / Move to Space"). Firefox
// only shows extension items here, not its own tab menu.
els.today.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("[data-tab]:not(.split)");
  if (!row) return;
  if (selection.has(row.dataset.sel) && selection.size > 1) {
    e.preventDefault();
    showMenu(selectionMenu(), e.clientX, e.clientY, () => schedule(true));
    return;
  }
  browser.menus.overrideContext({ context: "tab", tabId: Number(row.dataset.tab) });
});

document.addEventListener("mousedown", (e) => {
  if (e.button === 1 && e.target.closest(".tab")) e.preventDefault(); // no autoscroll
});

els.today.addEventListener("dblclick", (e) => {
  if (!e.target.closest(".tab")) newTabInSpace();
});

// New Tab opens Arc's command bar in a new tab (see palette/).
els.newTab.addEventListener("click", () => newTabInSpace());
els.newTabLink.addEventListener("click", () => newTabInSpace());

els.clear.addEventListener("click", async () => {
  const ids = state.tabs
    .filter((t) => !state.tabItem.has(t.id) && spaceOf(t) === state.spaceId)
    .map((t) => t.id);
  if (!ids.length) return;
  // Keep the space (and window) alive with a fresh tab.
  await newTabInSpace();
  await browser.tabs.remove(ids);
});

/* ---------- Drag and drop ---------- */

function clearDropMarks() {
  for (const el of document.querySelectorAll(".drop-before, .drop-after, .drop-into, .drag-over")) {
    el.classList.remove("drop-before", "drop-after", "drop-into", "drag-over");
  }
}

const accepts = (e) => e.dataTransfer.types.includes(ITEM_MIME) || e.dataTransfer.types.includes(TAB_MIME);

function readTabData(dt) {
  try {
    return JSON.parse(dt.getData(TAB_MIME));
  } catch {
    return null;
  }
}

let dragKind = null; // "item" | "folder" | "tab" for drags started in this sidebar

document.addEventListener("dragstart", (e) => {
  const itemEl = e.target.closest?.("[data-item]");
  dragKind = itemEl ? (itemEl.classList.contains("folder") ? "folder" : "item") : "tab";
  const row = e.target.closest?.("[data-tab]");
  if (itemEl) {
    const tab = state.bound.get(itemEl.dataset.item);
    const found = ArcFox.findItem(localState(), itemEl.dataset.item);
    e.dataTransfer.setData(ITEM_MIME, itemEl.dataset.item);
    if (found) e.dataTransfer.setData("text/uri-list", tab?.url || found.item.url);
    itemEl.classList.add("dragging");
  } else if (row) {
    const tab = tabById(Number(row.dataset.tab));
    e.dataTransfer.setData(TAB_MIME, JSON.stringify({ tabId: Number(row.dataset.tab) }));
    if (tab) e.dataTransfer.setData("text/uri-list", tab.url);
    row.classList.add("dragging");
  } else {
    return;
  }
  e.dataTransfer.effectAllowed = "move";
  dragging = true;
  hideMenu();
});

// Show drop zones (e.g. a hidden favorites area) while an ArcFox drag is over this sidebar.
document.addEventListener("dragenter", (e) => {
  if (accepts(e)) document.body.classList.add("drag-active");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("drag-active");
});
document.addEventListener("drop", () => document.body.classList.remove("drag-active"));

document.addEventListener("dragend", () => {
  dragKind = null;
  document.body.classList.remove("drag-active");
  dragging = false;
  for (const el of document.querySelectorAll(".dragging")) el.classList.remove("dragging");
  clearDropMarks();
  schedule(true);
});

function onZoneLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) clearDropMarks();
}

/** Mark the row under the pointer as drop-before/after; returns nothing. */
function markRow(e, zone, fallback) {
  clearDropMarks();
  const row = e.target.closest(".tab");
  if (row && zone.contains(row)) {
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
  } else if (zone.lastElementChild && zone.tagName === "UL") {
    zone.lastElementChild.classList.add("drop-after");
  } else {
    fallback.classList.add("drag-over");
  }
}

/** Where a drop into the pinned list goes: {before, parent} (folders aware). */
function pinnedDropTarget() {
  const into = els.pinned.querySelector(".drop-into");
  if (into) return { before: null, parent: into.dataset.item };
  const mark = els.pinned.querySelector(".drop-before, .drop-after");
  if (!mark) return { before: null, parent: null };
  const parent = mark.dataset.parent || null;
  if (mark.classList.contains("drop-before")) return { before: mark.dataset.item, parent };
  // After: the next row at the same level (skipping an open folder's items).
  let next = mark.nextElementSibling;
  while (next && parent === null && next.dataset.parent) next = next.nextElementSibling;
  const sameLevel = next && (next.dataset.parent || null) === parent;
  return { before: sameLevel ? next.dataset.item : null, parent };
}

// Favorites grid.
els.favorites.addEventListener("dragover", (e) => {
  if (!accepts(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  const tile = e.target.closest(".tile");
  if (tile) {
    const r = tile.getBoundingClientRect();
    const target = e.clientX > r.left + r.width / 2 ? tile.nextElementSibling : tile;
    if (target) target.classList.add("drop-before");
    else els.favorites.classList.add("drag-over");
  } else {
    els.favorites.classList.add("drag-over");
  }
});
els.favorites.addEventListener("dragleave", onZoneLeave);
els.favorites.addEventListener("drop", async (e) => {
  e.preventDefault();
  const before = els.favorites.querySelector(".tile.drop-before")?.dataset.item || null;
  clearDropMarks();
  const itemId = e.dataTransfer.getData(ITEM_MIME);
  if (itemId) await ArcFox.moveItem(itemId, state.favKey, before);
  else {
    const data = readTabData(e.dataTransfer);
    const tab = data && (await browser.tabs.get(data.tabId).catch(() => null));
    if (tab) await ArcFox.addItem(state.favKey, tab, before);
  }
  schedule(true);
});

// Pinned list (and the space header above it).
for (const zone of [els.pinned, els.spaceHead]) {
  zone.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (zone === els.spaceHead) {
      clearDropMarks();
      els.spaceHead.classList.add("drag-over");
    } else {
      markRow(e, els.pinned, els.spaceHead);
      // Middle of a folder row: drop into the folder.
      const row = e.target.closest(".tab.folder");
      if (row && dragKind !== "folder") {
        const r = row.getBoundingClientRect();
        if (Math.abs(e.clientY - (r.top + r.height / 2)) < r.height * 0.3) {
          clearDropMarks();
          row.classList.add("drop-into");
        }
      }
    }
  });
  zone.addEventListener("dragleave", onZoneLeave);
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    const { before, parent } =
      zone === els.pinned ? pinnedDropTarget() : { before: state.pins[0]?.id || null, parent: null };
    clearDropMarks();
    const key = ArcFox.pinKey(state.spaceId);
    const itemId = e.dataTransfer.getData(ITEM_MIME);
    if (itemId) await ArcFox.moveItem(itemId, key, before, { parent });
    else {
      const data = readTabData(e.dataTransfer);
      const tab = data && (await browser.tabs.get(data.tabId).catch(() => null));
      if (tab) await ArcFox.addItem(key, tab, before, { parent });
    }
    schedule(true);
  });
}

// Today list: reorder tabs, or drag an item out to make it a normal tab.
for (const zone of [els.today, els.newTab]) {
  zone.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    markRow(e, els.today, els.today);
  });
  zone.addEventListener("dragleave", onZoneLeave);
  zone.addEventListener("drop", onTodayDrop);
}

async function onTodayDrop(e) {
  e.preventDefault();
  const mark = els.today.querySelector(".drop-before, .drop-after");
  const after = !!mark?.classList.contains("drop-after");
  const targetId = mark ? Number(after ? mark.dataset.lastTab || mark.dataset.tab : mark.dataset.tab) : null;
  clearDropMarks();

  let tabId = null;
  const itemId = e.dataTransfer.getData(ITEM_MIME);
  if (itemId) {
    const st = await ArcFox.getState();
    const found = ArcFox.findItem(st, itemId);
    const tab = await ArcFox.removeItem(itemId, state.spaceId);
    if (tab) tabId = tab.id;
    else if (found) tabId = (await newTabInSpace(found.item.url)).id;
  } else {
    tabId = readTabData(e.dataTransfer)?.tabId ?? null;
  }
  if (tabId === null) return;

  try {
    const fresh = await browser.tabs.query({ windowId: state.windowId });
    const cur = await browser.tabs.get(tabId);
    const target = targetId !== null && fresh.find((t) => t.id === targetId);
    let index = target ? target.index + (after ? 1 : 0) : fresh.length;
    if (cur.windowId === state.windowId && cur.index < index) index -= 1;
    if (cur.windowId !== state.windowId || cur.index !== index) {
      await browser.tabs.move(tabId, { windowId: state.windowId, index });
    }
    // Tab dragged in from another window's sidebar joins this space.
    if (cur.windowId !== state.windowId) await ArcFox.setTabSpace(tabId, state.spaceId);
  } catch (err) {
    console.error("ArcFox: tab drop failed", err);
  }
  schedule(true);
}

/* ---------- Live updates ---------- */

// The command bar tells the sidebar where a tab is headed the moment Enter is
// pressed: Firefox only reports the new URL once the page commits, which is a
// slow beat to wait for on a cold connection.
const pendingNav = new Map(); // tabId -> { label, at }

function noteNavigation(tabId, label) {
  pendingNav.set(tabId, { label, at: Date.now() });
  setTimeout(() => {
    if (pendingNav.get(tabId)?.at <= Date.now() - 30000) {
      pendingNav.delete(tabId);
      schedule();
    }
  }, 30000);
  schedule();
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "arcfox:changed") schedule(true);
  if (msg?.type === "arcfox:navigating" && msg.tabId !== undefined) noteNavigation(msg.tabId, msg.label);
  if (msg?.type === "arcfox:focus-address" && msg.windowId === state.windowId) {
    browser.storage.session.remove("focusAddress");
    address.focus();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && ArcFox.BADGES_KEY in changes) schedule();
  if (area !== "local") return;
  const keys = Object.keys(changes);
  const data = keys.some((k) => k === ArcFox.SPACES_KEY || k.startsWith(ArcFox.FAV_KEY) || k.startsWith(ArcFox.PIN_PREFIX));
  if (data) schedule(true);
  else if (keys.includes(ArcFox.ICON_KEY) || keys.includes(HIDE_FAV_HINT)) schedule();
});

// Firefox creates its blank tab at the end of the list; Arc replaces it with a
// command-bar tab at the top a moment later. Draw it at the top from the start.
const preSwapTabs = new Set();
// Tabs Arc is about to throw away: a Cmd+T while the command bar is open.
const doomedTabs = new Set();

browser.tabs.onCreated.addListener((tab) => {
  // A fresh Cmd+T tab often reports about:blank before its page loads.
  if (tab.openerTabId === undefined && (ArcFox.isFirefoxNewTab(tab.url) || !tab.url || tab.url === "about:blank")) {
    const set = openCommandBar() ? doomedTabs : preSwapTabs;
    set.add(tab.id);
    setTimeout(() => {
      set.delete(tab.id);
      schedule();
    }, 1500);
  }
  schedule(true);
  // Background tags new tabs with a space shortly after creation.
  setTimeout(() => schedule(true), 400);
});

// Right after onRemoved, tabs.query() can still return the closing tab; keep
// it out of the list until Firefox has really dropped it.
const removedTabs = new Set();

browser.tabs.onRemoved.addListener((tabId) => {
  preSwapTabs.delete(tabId);
  doomedTabs.delete(tabId);
  pendingNav.delete(tabId);
  lastIcon.delete(tabId);
  removedTabs.add(tabId);
  setTimeout(() => removedTabs.delete(tabId), 5000);
  state.tabItem.delete(tabId);
  state.tabSpace.delete(tabId);
  schedule();
});
browser.tabs.onUpdated.addListener((tabId, changes) => {
  // The page committed (or went somewhere else): the guess isn't needed.
  if (changes.url !== undefined && !ArcFox.isNewTabUrl(changes.url)) pendingNav.delete(tabId);
  schedule();
}, {
  properties: ["title", "status", "favIconUrl", "pinned", "discarded", "audible", "mutedInfo", "url", "hidden", "splitViewId"],
});
for (const ev of ["onActivated", "onMoved", "onAttached", "onDetached"]) {
  browser.tabs[ev].addListener(() => schedule(ev !== "onMoved"));
}

(async () => {
  const win = await browser.windows.getCurrent();
  state.windowId = win.id;
  // Private windows show tabs only — no favorites, pins, folders or spaces.
  state.private = win.incognito;
  document.body.classList.toggle("private", state.private);
  await refresh();
  const { focusAddress } = await browser.storage.session.get("focusAddress");
  if (focusAddress === state.windowId) {
    browser.storage.session.remove("focusAddress");
    address.focus();
  }
})();
