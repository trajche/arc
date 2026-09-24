/* global ArcFox */
"use strict";

const MENU = {
  favAdd: "arcfox-fav-add",
  favRemove: "arcfox-fav-remove",
  pin: "arcfox-pin",
  unpin: "arcfox-unpin",
  move: "arcfox-move",
};
const MOVE_PREFIX = "arcfox-move:";
let moveChildren = [];

/* ---------- Sidebar show/hide (Option+Shift+S) ----------
 * The sidebar stays open as far as Firefox knows; hiding is a window title
 * marker that extras/userChrome.css matches (#main-window[titlepreface]). */

const HIDDEN_VALUE = "arcfoxHidden";
const HIDDEN_MARK = "\u200B"; // zero-width space: invisible in the window title

/* One invisible character per space color. Firefox's own sidebar panels
 * (history, bookmarks, synced tabs, the AI chat) are chrome, so they can't
 * read Arc's colors; this is how extras/userChrome.css learns which tint to
 * paint behind them. */
const COLOR_MARKS = {
  blue: "\u200C",
  turquoise: "\u200D",
  green: "\u2060",
  yellow: "\u2061",
  orange: "\u2062",
  red: "\u2063",
  pink: "\u2064",
  purple: "\uFEFF",
};

/** Write both markers (hidden state, space color) into the window title. */
async function applyWindowMarks(windowId, hiddenOverride) {
  const hidden =
    hiddenOverride ?? (await browser.sessions.getWindowValue(windowId, HIDDEN_VALUE).catch(() => false));
  let mark = COLOR_MARKS.purple;
  const win = await browser.windows.get(windowId).catch(() => null);
  if (win && !win.incognito) {
    const state = await ArcFox.getState();
    const spaceId = await ArcFox.getWindowSpace(windowId, state);
    const space = state.spaces.find((s) => s.id === spaceId);
    mark = COLOR_MARKS[space?.color] || COLOR_MARKS.purple;
  }
  await browser.windows.update(windowId, { titlePreface: (hidden ? HIDDEN_MARK : "") + mark });
}

async function applySidebarHidden(windowId, hidden) {
  await applyWindowMarks(windowId, hidden);
}

// The space (and so the tint) changes from the sidebar, which doesn't touch
// the window title itself.
let markTimer = 0;
function refreshWindowMarks() {
  clearTimeout(markTimer);
  markTimer = setTimeout(async () => {
    for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
      await applyWindowMarks(win.id).catch(() => {});
    }
  }, 150);
}

async function toggleSidebar(windowId) {
  const hidden = !(await browser.sessions.getWindowValue(windowId, HIDDEN_VALUE).catch(() => false));
  await browser.sessions.setWindowValue(windowId, HIDDEN_VALUE, hidden);
  await applySidebarHidden(windowId, hidden);
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "arcfox:changed") refreshWindowMarks();
});

/* ---------- Tab badges from other extensions ---------- */

// Other extensions can tag tabs in the sidebar, e.g. Tab Driver marks tabs an AI agent controls:
//   browser.runtime.sendMessage("arc@sidebar", {
//     type: "arcsidebar:set-badges",
//     badges: [{ tabId, label: "AI", title: "Claude is controlling this tab", color: "#7c5cff" }],
//   });
// Each call replaces that extension's badges; an empty list clears them. Badges last until
// Firefox restarts or Arc updates; then Arc sends { type: "arcsidebar:ready" } to every
// extension that set badges before, so they can send them again.
browser.runtime.onMessageExternal.addListener((msg, sender) => {
  if (msg?.type !== "arcsidebar:set-badges" || !sender.id) return;
  return ArcFox.setBadges(sender.id, msg.badges).then(() => ({ ok: true }));
});
browser.runtime.onStartup.addListener(() => ArcFox.announceToBadgeProviders());
browser.runtime.onInstalled.addListener(() => ArcFox.announceToBadgeProviders());

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "arcfox:toggle-sidebar") return;
  const windowId = msg.windowId ?? sender.tab?.windowId;
  if (windowId !== undefined) toggleSidebar(windowId);
});

// Title markers don't survive restarts; re-apply the saved state.
browser.windows.onCreated.addListener(async (win) => {
  applyWindowMarks(win.id).catch(() => {});
  if (await browser.sessions.getWindowValue(win.id, HIDDEN_VALUE).catch(() => false)) {
    applySidebarHidden(win.id, true);
  }
});

/* ---------- Setup & migration ---------- */

function createMenus() {
  browser.menus.removeAll().then(() => {
    moveChildren = [];
    browser.menus.create({ id: MENU.favAdd, title: "Add to Favorites", contexts: ["tab", "page"] });
    browser.menus.create({ id: MENU.favRemove, title: "Remove from Favorites", contexts: ["tab", "page"], visible: false });
    browser.menus.create({ id: MENU.pin, title: "Pin in Space", contexts: ["tab"] });
    browser.menus.create({ id: MENU.unpin, title: "Unpin from Space", contexts: ["tab"], visible: false });
    browser.menus.create({ id: MENU.move, title: "Move to Space", contexts: ["tab"] });
  });
}

/** Tag existing tabs with their window's space, convert native pins, hide other spaces. */
async function initWindows() {
  const state = await ArcFox.getState();
  for (const win of await browser.windows.getAll({ populate: true, windowTypes: ["normal"] })) {
    if (win.incognito) continue; // private windows show tabs only
    const spaceId = await ArcFox.getWindowSpace(win.id, state);
    for (const tab of win.tabs) {
      if (tab.pinned) {
        await ArcFox.convertNativePin(tab);
      } else if (!(await ArcFox.getTabItem(tab.id)) && !(await ArcFox.getTabSpace(tab.id))) {
        await ArcFox.setTabSpace(tab.id, spaceId);
      }
    }
    await ArcFox.syncVisibility(win.id);
    // Blank tabs restored before Arc was listening missed their hand-off to
    // the command bar (handleNewTabPage); do it now.
    const palette = browser.runtime.getURL("palette/");
    for (const tab of win.tabs) {
      const blank = ArcFox.isNewTabUrl(tab.url) || tab.url === "about:blank";
      if (blank && !tab.url.startsWith(palette)) await handleNewTabPage(tab).catch(() => {});
    }
    if (await browser.sessions.getWindowValue(win.id, HIDDEN_VALUE).catch(() => false)) {
      await applySidebarHidden(win.id, true);
    }
  }
}

/** Installing from an .xpi file leaves a blank tab titled with the file path; close it. */
async function closeInstallerTabs() {
  const tabs = await browser.tabs.query({ url: "about:blank" }).catch(() => []);
  const leftovers = tabs.filter((t) => /\.xpi$/i.test(t.title || ""));
  if (leftovers.length) await browser.tabs.remove(leftovers.map((t) => t.id));
}

browser.runtime.onInstalled.addListener(({ reason }) => {
  createMenus();
  initWindows();
  closeInstallerTabs();
  // First install only: show what Arc does and how to set up the layout.
  if (reason === "install") browser.tabs.create({ url: browser.runtime.getURL("welcome/welcome.html") });
});

browser.runtime.onStartup.addListener(() => {
  createMenus();
  ArcFox.forgetBlankClosedTabs();
  // Give session restore a moment to put tab values back.
  setTimeout(initWindows, 1500);
});

/* ---------- Tab lifecycle ---------- */

browser.tabs.onCreated.addListener((tab) => {
  // Cmd/Ctrl+T: swap the blank tab for the command bar right away instead of
  // waiting for Arc's new-tab page to load and report in — that page load is
  // the delay before the search field is ready.
  if (tab.openerTabId === undefined && ArcFox.isNewTabUrl(tab.url)) {
    handleNewTabPage(tab).catch(() => {});
    return;
  }
  const blank = tab.openerTabId === undefined && tab.url === "about:blank";
  // Firefox puts its own new tab at the end of the strip; pull it to the top
  // before the command bar takes its place.
  if (blank) placeNewTab(tab).catch(() => {});
  setTimeout(() => ArcFox.adoptTab(tab.id), blank ? 1500 : 300);
});

/**
 * A tab Firefox just made for Cmd/Ctrl+T. A second one while the command bar
 * is open goes straight back to it; otherwise pull the tab to the top of the
 * space, where the command bar will replace it.
 */
async function placeNewTab(tab) {
  if (await reuseCommandBar(tab)) return;
  await hoistNewTab(tab);
}

/** Move a tab Firefox just created to the top of its window's space. */
async function hoistNewTab(tab) {
  if (tab.incognito) return;
  const spaceId = await ArcFox.getWindowSpace(tab.windowId, await ArcFox.getState());
  const index = await ArcFox.topIndexOfSpace(tab.windowId, spaceId, { ignoreTabId: tab.id });
  // Only ever pull a tab up: a tab Arc opened is already at the top, and the
  // index above ignores it, so moving there would push it down one row.
  if (index >= 0 && tab.index > index) await browser.tabs.move(tab.id, { index }).catch(() => {});
}

/**
 * Arc's new-tab page just loaded in `tab` (Cmd/Ctrl+T, New Tab, a new window,
 * a blank tab Arc created). Replace it with a tab on the command bar: Firefox
 * keeps keyboard focus in its (hidden) URL bar for new-tab pages, but a tab
 * opened on a real page URL gets focus in the page, so the search field is
 * ready for typing.
 */
const handledNewTabs = new Set();

/**
 * Cmd/Ctrl+T. Arc owns the shortcut, so Firefox never opens its own blank tab:
 * either the command bar already in this window comes forward, or a new one
 * opens at the top of the space.
 */
async function openCommandBar(windowId) {
  const open = await commandBarIn(windowId);
  if (open) {
    await browser.tabs.update(open.id, { active: true });
    return open;
  }
  const url = browser.runtime.getURL("palette/palette.html");
  const win = await browser.windows.get(windowId).catch(() => null);
  if (win?.incognito) {
    const tabs = await browser.tabs.query({ windowId });
    const tab = await browser.tabs.create({ url, windowId, index: tabs.filter((t) => t.pinned).length, active: true });
    commandBars.set(windowId, tab.id);
    return tab;
  }
  const state = await ArcFox.getState();
  const spaceId = await ArcFox.getWindowSpace(windowId, state);
  const space = state.spaces.find((s) => s.id === spaceId);
  const index = await ArcFox.topIndexOfSpace(windowId, spaceId);
  const tab = await ArcFox.createTabInSpace(windowId, space, { url, index, active: true });
  commandBars.set(windowId, tab.id);
  return tab;
}

/**
 * Cmd/Ctrl+W. Arc owns the shortcut so the last tab of a space can stay: an
 * empty space always keeps its command bar, and closing it would only make
 * Firefox open a blank tab in its place.
 */
async function closeActiveTab() {
  const win = await browser.windows.getLastFocused().catch(() => null);
  if (!win) return;
  // Arc's own windows (the space editor) have no tabs to close: close them.
  if (win.type !== "normal") {
    await browser.windows.remove(win.id).catch(() => {});
    return;
  }
  const windowId = win.id;
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (!tab) return;
  const rest = (await browser.tabs.query({ windowId, hidden: false })).filter((t) => t.id !== tab.id && !t.pinned);
  if (!rest.length) {
    // Nothing else in this space: keep (or restore) the command bar instead.
    if (commandBars.get(windowId) === tab.id || ArcFox.isNewTabUrl(tab.url)) return;
    await openCommandBar(windowId);
  }
  await browser.tabs.remove(tab.id);
}

/** Send a redundant new tab back to the command bar that is already open. */
async function reuseCommandBar(tab) {
  const open = await commandBarIn(tab.windowId, tab.id);
  if (!open) return false;
  handledNewTabs.add(tab.id);
  await browser.tabs.remove(tab.id).catch(() => {});
  const back = await browser.tabs.get(open.id).catch(() => null);
  if (back && !back.active) await browser.tabs.update(open.id, { active: true }).catch(() => {});
  return true;
}

// Command-bar tabs by window, so a redundant Cmd+T can be undone at once
// instead of after a tabs.query round trip.
const commandBars = new Map();

function trackCommandBar(tab) {
  if (!tab || tab.id === undefined) return;
  if ((tab.url || "").startsWith(browser.runtime.getURL("palette/palette.html"))) commandBars.set(tab.windowId, tab.id);
  else if (commandBars.get(tab.windowId) === tab.id) commandBars.delete(tab.windowId);
}

browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.url !== undefined) trackCommandBar(tab);
});
browser.tabs.onRemoved.addListener((tabId, info) => {
  if (commandBars.get(info.windowId) === tabId) commandBars.delete(info.windowId);
});

/** A visible command-bar tab in `windowId`, if one is already open. */
async function commandBarIn(windowId, ignoreTabId) {
  const known = commandBars.get(windowId);
  if (known !== undefined && known !== ignoreTabId) {
    const tab = await browser.tabs.get(known).catch(() => null);
    if (tab && !tab.hidden) return tab;
    commandBars.delete(windowId);
  }
  const url = browser.runtime.getURL("palette/palette.html");
  const tabs = await browser.tabs.query({ windowId });
  const open = tabs.find((t) => t.id !== ignoreTabId && !t.hidden && (t.url || "").startsWith(url)) || null;
  if (open) commandBars.set(windowId, open.id);
  return open;
}

async function handleNewTabPage(tab) {
  if (handledNewTabs.has(tab.id)) return;
  handledNewTabs.add(tab.id);
  setTimeout(() => handledNewTabs.delete(tab.id), 10000);
  // One command bar per window: a second Cmd+T returns to the open one.
  const open = await commandBarIn(tab.windowId, tab.id);
  if (open) {
    await browser.tabs.update(open.id, { active: true });
    await browser.tabs.remove(tab.id);
    return;
  }
  if (tab.incognito) {
    // Private windows have no spaces or containers: a plain command-bar tab.
    const tabs = await browser.tabs.query({ windowId: tab.windowId });
    await browser.tabs.create({
      url: browser.runtime.getURL("palette/palette.html"),
      windowId: tab.windowId,
      index: tabs.filter((t) => t.pinned).length, // top of the list
      active: tab.active,
    });
    await browser.tabs.remove(tab.id);
    return;
  }
  const state = await ArcFox.getState();
  let spaceId = await ArcFox.getTabSpace(tab.id);
  if (!state.spaces.some((s) => s.id === spaceId)) spaceId = await ArcFox.getWindowSpace(tab.windowId, state);
  const space = state.spaces.find((s) => s.id === spaceId);
  // New tabs go to the top of the space's list, like Arc.
  const index = await ArcFox.topIndexOfSpace(tab.windowId, spaceId, { ignoreTabId: tab.id });
  await ArcFox.createTabInSpace(tab.windowId, space, {
    url: browser.runtime.getURL("palette/palette.html"),
    index,
    active: tab.active,
  });
  await browser.tabs.remove(tab.id);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "arcfox:newtab" && sender.tab) handleNewTabPage(sender.tab);
});

// Blank pages Arc swaps or cancels shouldn't clog Cmd/Ctrl+Shift+T.
let forgetTimer = 0;
browser.tabs.onRemoved.addListener(() => {
  clearTimeout(forgetTimer);
  forgetTimer = setTimeout(() => ArcFox.forgetBlankClosedTabs(), 150);
});

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito) return; // private windows keep no spaces
  const state = await ArcFox.getState();
  const itemId = await ArcFox.getTabItem(tabId);
  if (itemId && state.favorites.some((f) => f.id === itemId)) return;
  const spaceId = await ArcFox.getTabSpace(tabId);
  if (!state.spaces.some((s) => s.id === spaceId)) return;
  await ArcFox.rememberActive(windowId, spaceId, tabId);
  // Tab from another space activated (e.g. via "Switch to tab"): follow it.
  if (spaceId !== (await ArcFox.getWindowSpace(windowId, state))) await ArcFox.syncVisibility(windowId);
});

browser.tabs.onUpdated.addListener(
  async (tabId, change, tab) => {
    if (change.pinned) {
      if (!tab.incognito) await ArcFox.convertNativePin(tab);
      return;
    }
    if (change.favIconUrl) {
      const itemId = await ArcFox.getTabItem(tabId);
      if (itemId) ArcFox.cacheIcon(itemId, change.favIconUrl);
    }
  },
  { properties: ["pinned", "favIconUrl"] }
);

/* ---------- Context menus ---------- */

/** Favorites list for a tab: that of its space's container. */
async function favKeyOfTab(tab, state) {
  const spaceId = (await ArcFox.getTabSpace(tab.id)) || (await ArcFox.getWindowSpace(tab.windowId, state));
  return ArcFox.favKey(state.spaces.find((s) => s.id === spaceId));
}

async function itemOfTab(tab) {
  const state = await ArcFox.getState();
  const itemId = tab && (await ArcFox.getTabItem(tab.id));
  return { state, found: itemId ? ArcFox.findItem(state, itemId) : null, itemId };
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.menuIds.includes(MENU.favAdd) || !tab) return;
  const { state, found } = await itemOfTab(tab);
  const isFav = !!found && ArcFox.isFavKey(found.key);
  const isPin = !!found && !isFav;
  const favoritable = ArcFox.isFavoritable(tab.url);
  browser.menus.update(MENU.favAdd, { visible: !isFav, enabled: favoritable });
  browser.menus.update(MENU.favRemove, { visible: isFav });
  browser.menus.update(MENU.pin, { visible: !found, enabled: favoritable });
  browser.menus.update(MENU.unpin, { visible: isPin });
  browser.menus.update(MENU.move, { visible: !isFav && state.spaces.length > 1 });

  for (const id of moveChildren) browser.menus.remove(id);
  moveChildren = [];
  const current = (await ArcFox.getTabSpace(tab.id)) || (await ArcFox.getWindowSpace(tab.windowId, state));
  for (const space of state.spaces) {
    const id = MOVE_PREFIX + space.id;
    browser.menus.create({
      id,
      parentId: MENU.move,
      title: `${space.icon ? space.icon + "  " : ""}${space.name}`,
      contexts: ["tab"],
      enabled: space.id !== current,
    });
    moveChildren.push(id);
  }
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith(MOVE_PREFIX)) {
    await ArcFox.moveTabToSpace(tab.id, id.slice(MOVE_PREFIX.length));
    return;
  }
  const { state, found, itemId } = await itemOfTab(tab);
  switch (id) {
    case MENU.favAdd:
      await ArcFox.addItem(await favKeyOfTab(tab, state), tab);
      break;
    case MENU.pin: {
      const spaceId = (await ArcFox.getTabSpace(tab.id)) || (await ArcFox.getWindowSpace(tab.windowId, state));
      await ArcFox.addItem(ArcFox.pinKey(spaceId), tab);
      break;
    }
    case MENU.favRemove:
    case MENU.unpin:
      if (found) await ArcFox.removeItem(itemId);
      break;
  }
});

/* ---------- Commands ---------- */

async function focusedWindowId() {
  return (await browser.windows.getLastFocused({ windowTypes: ["normal"] })).id;
}

async function cycleSpace(step) {
  const windowId = await focusedWindowId();
  const state = await ArcFox.getState();
  const current = await ArcFox.getWindowSpace(windowId, state);
  const i = state.spaces.findIndex((s) => s.id === current);
  const next = state.spaces[(i + step + state.spaces.length) % state.spaces.length];
  await ArcFox.switchSpace(windowId, next.id);
}

browser.commands.onCommand.addListener(async (command) => {
  if (command === "new-tab") {
    await openCommandBar(await focusedWindowId());
  } else if (command === "close-tab") {
    await closeActiveTab();
  } else if (command === "focus-address") {
    browser.sidebarAction.open(); // must run synchronously inside the user action
    const windowId = await focusedWindowId();
    // Sidebar may still be loading; it also checks for a pending focus on startup.
    await browser.storage.session.set({ focusAddress: windowId });
    browser.runtime.sendMessage({ type: "arcfox:focus-address", windowId }).catch(() => {});
  } else if (command === "toggle-sidebar") {
    await toggleSidebar(await focusedWindowId());
  } else if (command === "add-favorite") {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) await ArcFox.addItem(await favKeyOfTab(tab, await ArcFox.getState()), tab);
  } else if (command === "next-space") {
    await cycleSpace(1);
  } else if (command === "prev-space") {
    await cycleSpace(-1);
  } else if (command.startsWith("space-")) {
    const state = await ArcFox.getState();
    const space = state.spaces[Number(command.slice(6)) - 1];
    if (space) await ArcFox.switchSpace(await focusedWindowId(), space.id);
  }
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});
