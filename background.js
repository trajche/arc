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

async function applySidebarHidden(windowId, hidden) {
  await browser.windows.update(windowId, { titlePreface: hidden ? HIDDEN_MARK : "" });
}

async function toggleSidebar(windowId) {
  const hidden = !(await browser.sessions.getWindowValue(windowId, HIDDEN_VALUE).catch(() => false));
  await browser.sessions.setWindowValue(windowId, HIDDEN_VALUE, hidden);
  await applySidebarHidden(windowId, hidden);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "arcfox:toggle-sidebar") return;
  const windowId = msg.windowId ?? sender.tab?.windowId;
  if (windowId !== undefined) toggleSidebar(windowId);
});

// Title markers don't survive restarts; re-apply the saved state.
browser.windows.onCreated.addListener(async (win) => {
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
  // Blank tabs are adopted when Arc's new-tab page loads and reports in
  // (handleNewTabPage). Fallback if it never does (e.g. override turned off).
  const blank = tab.openerTabId === undefined && (ArcFox.isNewTabUrl(tab.url) || tab.url === "about:blank");
  setTimeout(() => ArcFox.adoptTab(tab.id), blank ? 1500 : 300);
});

/**
 * Arc's new-tab page just loaded in `tab` (Cmd/Ctrl+T, New Tab, a new window,
 * a blank tab Arc created). Replace it with a tab on the command bar: Firefox
 * keeps keyboard focus in its (hidden) URL bar for new-tab pages, but a tab
 * opened on a real page URL gets focus in the page, so the search field is
 * ready for typing.
 */
async function handleNewTabPage(tab) {
  const state = await ArcFox.getState();
  let spaceId = await ArcFox.getTabSpace(tab.id);
  if (!state.spaces.some((s) => s.id === spaceId)) spaceId = await ArcFox.getWindowSpace(tab.windowId, state);
  const space = state.spaces.find((s) => s.id === spaceId);
  await ArcFox.createTabInSpace(tab.windowId, space, {
    url: browser.runtime.getURL("palette/palette.html"),
    index: tab.index,
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
      await ArcFox.convertNativePin(tab);
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
  if (command === "focus-address") {
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
