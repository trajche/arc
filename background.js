/* global ArcFox */
"use strict";

const MENU = {
  favAdd: "arcfox-fav-add",
  favRemove: "arcfox-fav-remove",
  pin: "arcfox-pin",
  unpin: "arcfox-unpin",
  move: "arcfox-move",
  closeAbove: "arcfox-close-above",
  closeBelow: "arcfox-close-below",
};
const MOVE_PREFIX = "arcfox-move:";
let moveChildren = [];
const EXT_PREFIX = "arcfox-ext:"; // tab menu items other extensions added
const extensionItems = new Map(); // menu id -> { extensionId, id, title } (null for the separator)

/* ---------- Window title markers ---------- */

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

/** Write the space-colour marker into the window title. */
async function applyWindowMarks(windowId) {
  let mark = COLOR_MARKS.purple;
  const win = await browser.windows.get(windowId).catch(() => null);
  if (win && !win.incognito) {
    const state = await ArcFox.getState();
    const spaceId = await ArcFox.getWindowSpace(windowId, state);
    const space = state.spaces.find((s) => s.id === spaceId);
    mark = COLOR_MARKS[space?.color] || COLOR_MARKS.purple;
  }
  await browser.windows.update(windowId, { titlePreface: mark });
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

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "arcfox:changed") refreshWindowMarks();
});

/* ---------- Tab badges from other extensions ---------- */

// Other extensions can tag tabs in the sidebar, e.g. Tab Driver marks tabs an AI agent controls:
//   browser.runtime.sendMessage("arc@sidebar", {
//     type: "arcsidebar:set-badges",
//     badges: [{ tabId, label: "AI", title: "Claude is controlling this tab", color: "#7c5cff" }],
//   });
// Optional: icon ("bot" or "sparkles", drawn instead of the label, styled like the sound icon),
// position ("start" puts it before the title, next to the sound icon; default "end", after
// the title), pulse (true blinks the badge; on an icon, a green dot blinks instead).
// Each call replaces that extension's badges; an empty list clears them. Badges last until
// Firefox restarts or Arc updates; then Arc sends { type: "arcsidebar:ready" } to every
// extension that set badges before, so they can send them again.
//
// They can also add items to the sidebar's tab menu (right-click on a tab):
//   browser.runtime.sendMessage("arc@sidebar", {
//     type: "arcsidebar:set-tab-menu",
//     items: [{ id: "control", title: "Let AI agents control this tab", exceptTabIds: [12] }],
//   });
// tabIds limits an item to those tabs, exceptTabIds hides it on them. A click sends
// { type: "arcsidebar:menu-clicked", id, tabId } back to that extension. Same lifetime as badges.
browser.runtime.onMessageExternal.addListener((msg, sender) => {
  if (!sender.id) return;
  if (msg?.type === "arcsidebar:set-badges") return ArcFox.setBadges(sender.id, msg.badges).then(() => ({ ok: true }));
  if (msg?.type === "arcsidebar:set-tab-menu") return ArcFox.setTabMenu(sender.id, msg.items).then(() => ({ ok: true }));
});
/* ---------- Freeing memory ----------
 * A space's tabs stay loaded while the space is hidden, so a window's memory is
 * every tab of every space at once. Tabs nobody has looked at for a while are
 * discarded: the row keeps its title, favicon and history, and the page loads
 * again on click. */

const IDLE_MINUTES = 45; // a tab in the space you're in: long enough to come back to
const HIDDEN_IDLE_MINUTES = 5; // a tab in another space: off screen, so unload it sooner
const SWEEP_MINUTES = 5;

/** Tabs that can be unloaded without taking something away from the user. */
function unloadable(tab, now) {
  if (tab.active || tab.discarded || tab.incognito || tab.audible) return false;
  if (tab.status === "loading") return false;
  if ((tab.url || "").startsWith("moz-extension:")) return false; // Arc's own pages
  // A hidden tab belongs to a space that isn't on screen: nothing is lost by
  // unloading it, and these are most of a window's memory.
  const idle = tab.hidden ? HIDDEN_IDLE_MINUTES : IDLE_MINUTES;
  return (tab.lastAccessed || 0) < now - idle * 60_000;
}

async function discardIdleTabs() {
  const now = Date.now();
  const tabs = await browser.tabs.query({}).catch(() => []);
  const stale = tabs.filter((t) => unloadable(t, now));
  let done = 0;
  for (const tab of stale) {
    await browser.tabs
      .discard(tab.id)
      .then(() => done++)
      .catch(() => {});
  }
  if (stale.length) console.log(`Arc: unloaded ${done}/${stale.length} idle tabs`);
}

// Leaving a space puts its tabs out of sight: sweep shortly after, so they go
// without waiting for the next scheduled pass.
browser.tabs.onUpdated.addListener((_id, changes) => {
  if (changes.hidden === true) setTimeout(discardIdleTabs, HIDDEN_IDLE_MINUTES * 60_000 + 5_000);
}, { properties: ["hidden"] });

browser.alarms.create("arcsidebar:discard-idle", { periodInMinutes: SWEEP_MINUTES });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "arcsidebar:discard-idle") discardIdleTabs();
});

browser.runtime.onStartup.addListener(() => ArcFox.announceToBadgeProviders());
browser.runtime.onInstalled.addListener(() => ArcFox.announceToBadgeProviders());
browser.runtime.onInstalled.addListener(() => ArcFox.adoptArcContainers().catch(() => {}));

// Title markers don't survive restarts; write this window's again.
browser.windows.onCreated.addListener((win) => {
  applyWindowMarks(win.id).catch(() => {});
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
    browser.menus.create({ id: MENU.closeAbove, title: "Close Tabs Above", contexts: ["tab"], visible: false });
    browser.menus.create({ id: MENU.closeBelow, title: "Close Tabs Below", contexts: ["tab"], visible: false });
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
  }
}

/** Installing from an .xpi file leaves a blank tab titled with the file path; close it. */
async function closeInstallerTabs() {
  const tabs = await browser.tabs.query({ url: "about:blank" }).catch(() => []);
  const leftovers = tabs.filter((t) => /\.xpi$/i.test(t.title || ""));
  if (leftovers.length) {
    const ids = leftovers.map((t) => t.id);
    ArcFox.markClosing(ids);
    await browser.tabs.remove(ids);
  }
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
  // Pull it up now — a tab that appears at the bottom and jumps is worse than
  // one that was never there — but wait before throwing it away.
  await hoistNewTab(tab);
  await reuseIfStillBlank(tab);
}

// Long enough for a tab opened with an address to report it. A tab in a
// container takes a moment longer than one without.
const BLANK_GRACE_MS = 400;

/**
 * Firefox reports about:blank for a tab that was opened with an address until
 * the load starts, so "blank" at creation doesn't mean blank: a favorite or a
 * pinned item Arc had just opened would be thrown away as a redundant new tab,
 * leaving the click doing nothing at all. Give the tab a moment to say where
 * it is going, and take Arc's own mark on it as proof that it isn't spare.
 */
async function reuseIfStillBlank(tab) {
  await new Promise((r) => setTimeout(r, BLANK_GRACE_MS));
  const fresh = await browser.tabs.get(tab.id).catch(() => null);
  if (!fresh || !(fresh.url === "about:blank" || ArcFox.isNewTabUrl(fresh.url))) return;
  if ((await ArcFox.getTabItem(tab.id)) || (await ArcFox.getTabSpace(tab.id))) return;
  await reuseCommandBar(fresh);
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
// Two Cmd+T presses in the same moment would both find no command bar and
// both open one, so a window's opens take turns.
const opening = new Map();

function openCommandBar(windowId) {
  const after = opening.get(windowId) || Promise.resolve();
  const open = after.then(() => openBar(windowId));
  opening.set(windowId, open.catch(() => {}));
  return open;
}

async function openBar(windowId) {
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
    paletteTabs.add(tab.id);
    commandBars.set(windowId, tab.id);
    return tab;
  }
  const state = await ArcFox.getState();
  const spaceId = await ArcFox.getWindowSpace(windowId, state);
  const space = state.spaces.find((s) => s.id === spaceId);
  const index = await ArcFox.topIndexOfSpace(windowId, spaceId);
  const tab = await ArcFox.createTabInSpace(windowId, space, { url, index, active: true });
  paletteTabs.add(tab.id);
  commandBars.set(windowId, tab.id);
  return tab;
}

/* ---------- Where focus goes when a tab closes ---------- */

/* Firefox picks the tab next to the one that closed. Arc goes back to the tab
   you were on before it, which is what you usually want after following a link
   out of a page you're still reading. */

const MRU_MAX = 50;
const MRU_KEY = "mru"; // storage.session: the event page can be suspended
let mru = null; // windowId -> tab ids, most recently active first

/** The order survives the background page being suspended between tabs. */
async function mruAll() {
  if (!mru) {
    const stored = await browser.storage.session.get(MRU_KEY).catch(() => ({}));
    mru = new Map(Object.entries(stored[MRU_KEY] || {}).map(([id, list]) => [Number(id), list]));
  }
  return mru;
}

function saveMru() {
  const plain = {};
  for (const [windowId, list] of mru) plain[windowId] = list;
  return browser.storage.session.set({ [MRU_KEY]: plain }).catch(() => {});
}

async function noteActive(windowId, tabId) {
  const all = await mruAll();
  const list = (all.get(windowId) || []).filter((id) => id !== tabId);
  list.unshift(tabId);
  if (list.length > MRU_MAX) list.length = MRU_MAX;
  all.set(windowId, list);
  await saveMru();
}

async function dropFromMru(tabId, windowId) {
  const all = await mruAll();
  for (const [id, list] of all) {
    if (windowId !== undefined && id !== windowId) continue;
    const rest = list.filter((t) => t !== tabId);
    if (rest.length) all.set(id, rest);
    else all.delete(id);
  }
  await saveMru();
}

// When the active tab closes, Firefox activates its own pick before it reports
// the removal: the tab Arc is told about is already off screen. What makes a
// close tell itself apart from a plain tab switch is that the switch away from
// the closing tab lands in the same breath as the removal.
const switchedFrom = new Map(); // windowId -> { from: tab id, at }

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const head = ((await mruAll()).get(windowId) || [])[0];
  if (head !== undefined && head !== tabId) switchedFrom.set(windowId, { from: head, at: Date.now() });
  await noteActive(windowId, tabId);
});
browser.tabs.onDetached.addListener((tabId, info) => dropFromMru(tabId, info.oldWindowId));
browser.windows.onRemoved.addListener(async (windowId) => {
  (await mruAll()).delete(windowId);
  await saveMru();
});

/**
 * The tab to go back to in `windowId`: the most recently active one that is
 * still open and on screen. Hidden tabs belong to other spaces, so they never
 * win — going back to one would switch space. `tabs` saves a query when the
 * caller already has the window's list.
 */
async function previousTab(windowId, { tabs = null, order = null, closing = [] } = {}) {
  const list = order || (await mruAll()).get(windowId) || [];
  if (!list.length) return null;
  const doomed = new Set([].concat(closing));
  const open = tabs || (await browser.tabs.query({ windowId }).catch(() => []));
  const alive = new Map(open.filter((t) => !t.hidden).map((t) => [t.id, t]));
  for (const id of list) {
    if (doomed.has(id)) continue;
    const tab = alive.get(id);
    if (tab) return tab;
  }
  return null;
}

/** Close these tabs, landing on the tab that was active before them. */
async function closeTabsTo(tabIds, windowId) {
  const ids = [].concat(tabIds);
  const back = await previousTab(windowId, { closing: ids });
  // The activation is sent first so Firefox never has to pick a tab itself:
  // picking one shows the wrong page for a frame.
  if (back && !back.active) browser.tabs.update(back.id, { active: true }).catch(() => {});
  ArcFox.markClosing(ids);
  await browser.tabs.remove(ids).catch(() => {});
}

// Closes Arc didn't make itself (a page closing its own tab, Firefox's menus):
// Firefox has already moved on by now, so this corrects the choice.
browser.tabs.onRemoved.addListener(async (tabId, info) => {
  const at0 = Date.now();
  const list = [...((await mruAll()).get(info.windowId) || [])];
  await dropFromMru(tabId, info.windowId);
  // Arc's own closes have already put you where they want you.
  if (ArcFox.takeClosing(tabId) || info.isWindowClosing) return;
  const switched = switchedFrom.get(info.windowId);
  // Either the removal came first, or Firefox's own pick is already on screen
  // and the tab it switched away from is the one that just closed.
  const wasOnScreen =
    list[0] === tabId || (switched && switched.from === tabId && at0 - switched.at < 200);
  if (!wasOnScreen) return;
  switchedFrom.delete(info.windowId);
  const at = list.indexOf(tabId);
  // Only tabs used before the closed one, from the order as it was: Firefox's
  // own pick lands at the head of the live list a moment later.
  const back = await previousTab(info.windowId, { order: list.slice(at + 1) });
  if (!back) return;
  // Firefox may still be choosing when the removal arrives first; let it, then
  // correct the choice.
  if (list[0] === tabId) await new Promise((r) => setTimeout(r, 120));
  const [now] = await browser.tabs.query({ windowId: info.windowId, active: true }).catch(() => []);
  if (!now || now.id === back.id) return;
  await browser.tabs.update(back.id, { active: true }).catch(() => {});
});

/**
 * Cmd/Ctrl+W. Arc owns the shortcut so the last tab of a space can stay: an
 * empty space always keeps its command bar, and closing it would only make
 * Firefox open a blank tab in its place.
 */
async function closeActiveTab() {
  // One populated window instead of three queries: every round trip to the
  // parent process is delay the user feels before the tab goes away.
  const win = await browser.windows.getLastFocused({ populate: true }).catch(() => null);
  if (!win) return;
  // Arc's own windows (the space editor) have no tabs to close: close them.
  if (win.type !== "normal") {
    await browser.windows.remove(win.id).catch(() => {});
    return;
  }
  const windowId = win.id;
  const tab = (win.tabs || []).find((t) => t.active);
  if (!tab) return;
  const rest = win.tabs.filter((t) => t.id !== tab.id && !t.hidden && !t.pinned);
  if (!rest.length) {
    // Nothing else in this space: keep (or restore) the command bar instead.
    if (commandBars.get(windowId) === tab.id || ArcFox.isNewTabUrl(tab.url)) return;
    await openCommandBar(windowId);
    ArcFox.markClosing(tab.id);
    await browser.tabs.remove(tab.id);
    return;
  }
  const back = await previousTab(windowId, { tabs: win.tabs, closing: tab.id });
  if (back) browser.tabs.update(back.id, { active: true }).catch(() => {});
  ArcFox.markClosing(tab.id);
  await browser.tabs.remove(tab.id);
}

/** Send a redundant new tab back to the command bar that is already open. */
async function reuseCommandBar(tab) {
  const open = await commandBarIn(tab.windowId, tab.id);
  if (!open) return false;
  handledNewTabs.add(tab.id);
  ArcFox.markClosing(tab.id);
  await browser.tabs.remove(tab.id).catch(() => {});
  const back = await browser.tabs.get(open.id).catch(() => null);
  if (back && !back.active) await browser.tabs.update(open.id, { active: true }).catch(() => {});
  return true;
}

// Command-bar tabs by window, so a redundant Cmd+T can be undone at once
// instead of after a tabs.query round trip.
const commandBars = new Map();
// Command bars by tab id. A tab Arc just opened reports about:blank for a
// moment, so the URL alone can't tell one: without this, a Cmd+T right after
// another would see no bar and open a second empty one.
const paletteTabs = new Set();
// Bars that have finished loading. After that, "loading" means the bar is on
// its way somewhere — the palette says so too, but only if its page got far
// enough to run.
const loadedBars = new Set();

const isPaletteUrl = (url) => (url || "").startsWith(browser.runtime.getURL("palette/palette.html"));

function trackCommandBar(tab) {
  if (!tab || tab.id === undefined) return;
  if (isPaletteUrl(tab.url)) {
    paletteTabs.add(tab.id);
    commandBars.set(tab.windowId, tab.id);
  } else {
    forgetCommandBar(tab.id, tab.windowId);
  }
}

function forgetCommandBar(tabId, windowId) {
  paletteTabs.delete(tabId);
  loadedBars.delete(tabId);
  leavingTabs.delete(tabId);
  if (commandBars.get(windowId) === tabId) commandBars.delete(windowId);
}

browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.url !== undefined) trackCommandBar(tab);
  if (changes.status === "complete") {
    if (paletteTabs.has(tabId)) loadedBars.add(tabId);
    // Note where the page was seen, so suggestions can stay inside a container.
    if (!tab.incognito) ArcFox.recordVisit(tab.url, tab.cookieStoreId).catch(() => {});
  }
  // A bar that has loaded and starts loading again is leaving: Firefox still
  // reports the palette's URL until the new page commits, so without this the
  // next Cmd+T would come back here.
  if (changes.status === "loading" && loadedBars.has(tabId)) noteLeaving(tab);
});
browser.tabs.onRemoved.addListener((tabId, info) => {
  forgetCommandBar(tabId, info.windowId);
});

/** A visible command-bar tab in `windowId`, if one is already open. */
/**
 * The tabs of `tab`'s space in sidebar order: what the list shows, so "above"
 * and "below" mean what they look like. Pinned items and favorites keep their
 * own rows and aren't part of it.
 */
async function listedTabs(tab) {
  const state = await ArcFox.getState();
  const spaceId = (await ArcFox.getTabSpace(tab.id)) || (await ArcFox.getWindowSpace(tab.windowId, state));
  const tabs = (await browser.tabs.query({ windowId: tab.windowId })).filter((t) => !t.pinned);
  const { tabItem, tabSpace } = await ArcFox.scanTabs(tabs, state);
  return tabs
    .filter((t) => !tabItem.has(t.id) && (tabSpace.get(t.id) ?? spaceId) === spaceId)
    .sort((a, b) => a.index - b.index);
}

/** Tabs of the same space above or below `tab` in the list. */
async function tabsAround(tab) {
  const listed = await listedTabs(tab);
  const at = listed.findIndex((t) => t.id === tab.id);
  if (at < 0) return { above: [], below: [] };
  return { above: listed.slice(0, at), below: listed.slice(at + 1) };
}

// Command bars on their way somewhere. Firefox reports a tab's new URL only
// once the page commits, so between Enter and the first paint the tab still
// looks like the command bar — and Cmd+T would return to it instead of opening
// a new one, which reads as the shortcut being dead until the page renders.
const leavingTabs = new Set();

function noteLeaving(tab) {
  leavingTabs.add(tab.id);
  setTimeout(() => leavingTabs.delete(tab.id), 20000);
  if (commandBars.get(tab.windowId) === tab.id) commandBars.delete(tab.windowId);
}

async function commandBarIn(windowId, ignoreTabId) {
  const known = commandBars.get(windowId);
  if (known !== undefined && known !== ignoreTabId && !leavingTabs.has(known)) {
    const tab = await browser.tabs.get(known).catch(() => null);
    // Still the command bar? Once it has been sent somewhere it is an ordinary
    // tab, and Cmd+T has to open a new command bar rather than return to it.
    if (tab && !tab.hidden && (paletteTabs.has(tab.id) || isPaletteUrl(tab.url))) return tab;
    commandBars.delete(windowId);
  }
  const tabs = await browser.tabs.query({ windowId });
  const open =
    tabs.find(
      (t) => t.id !== ignoreTabId && !leavingTabs.has(t.id) && !t.hidden && (paletteTabs.has(t.id) || isPaletteUrl(t.url))
    ) || null;
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
    ArcFox.markClosing(tab.id);
    await browser.tabs.remove(tab.id);
    return;
  }
  if (tab.incognito) {
    // Private windows have no spaces or containers: a plain command-bar tab.
    const tabs = await browser.tabs.query({ windowId: tab.windowId });
    const bar = await browser.tabs.create({
      url: browser.runtime.getURL("palette/palette.html"),
      windowId: tab.windowId,
      index: tabs.filter((t) => t.pinned).length, // top of the list
      active: tab.active,
    });
    paletteTabs.add(bar.id);
    commandBars.set(tab.windowId, bar.id);
    ArcFox.markClosing(tab.id);
    await browser.tabs.remove(tab.id);
    return;
  }
  const state = await ArcFox.getState();
  let spaceId = await ArcFox.getTabSpace(tab.id);
  if (!state.spaces.some((s) => s.id === spaceId)) spaceId = await ArcFox.getWindowSpace(tab.windowId, state);
  const space = state.spaces.find((s) => s.id === spaceId);
  // New tabs go to the top of the space's list, like Arc.
  const index = await ArcFox.topIndexOfSpace(tab.windowId, spaceId, { ignoreTabId: tab.id });
  const bar = await ArcFox.createTabInSpace(tab.windowId, space, {
    url: browser.runtime.getURL("palette/palette.html"),
    index,
    active: tab.active,
  });
  paletteTabs.add(bar.id);
  commandBars.set(tab.windowId, bar.id);
  ArcFox.markClosing(tab.id);
  await browser.tabs.remove(tab.id);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "arcfox:newtab" && sender.tab) handleNewTabPage(sender.tab);
  // The sidebar closing a tab: the background knows which tab to land on.
  if (msg?.type === "arcfox:close-tab" && msg.tabIds) return closeTabsTo(msg.tabIds, msg.windowId);
  // The command bar is leaving: it stops counting as one now, not when the
  // page it opened finishes loading.
  if (msg?.type === "arcfox:navigating" && sender.tab) noteLeaving(sender.tab);
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

  // Count them so the menu says what it will close.
  const { above, below } = await tabsAround(tab);
  const plural = (n) => `${n} Tab${n === 1 ? "" : "s"}`;
  browser.menus.update(MENU.closeAbove, { visible: above.length > 0, title: `Close ${plural(above.length)} Above` });
  browser.menus.update(MENU.closeBelow, { visible: below.length > 0, title: `Close ${plural(below.length)} Below` });

  for (const id of moveChildren) browser.menus.remove(id);
  moveChildren = [];
  for (const id of extensionItems.keys()) browser.menus.remove(id);
  extensionItems.clear();
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
  // Items other extensions added (e.g. Tab Driver's "Let AI agents control this tab"),
  // unless that extension has been disabled or removed since.
  await ArcFox.pruneProviders(true);
  const extra = await ArcFox.tabMenuFor(tab.id);
  if (extra.length) {
    browser.menus.create({ id: EXT_PREFIX + "separator", type: "separator", contexts: ["tab"] });
    extensionItems.set(EXT_PREFIX + "separator", null);
  }
  extra.forEach((item, i) => {
    const id = EXT_PREFIX + i;
    browser.menus.create({ id, title: item.title, contexts: ["tab"] });
    extensionItems.set(id, item);
  });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  const item = extensionItems.get(id);
  if (item) {
    browser.runtime.sendMessage(item.extensionId, { type: "arcsidebar:menu-clicked", id: item.id, tabId: tab.id }).catch(() => {});
    return;
  }
  if (id === MENU.closeAbove || id === MENU.closeBelow) {
    const { above, below } = await tabsAround(tab);
    const doomed = (id === MENU.closeAbove ? above : below).map((t) => t.id);
    if (doomed.length) {
      ArcFox.markClosing(doomed);
      await browser.tabs.remove(doomed);
    }
    return;
  }
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

// Firefox suspends the event page once it falls idle, and waking it back up
// delays the first Cmd/Ctrl+T or Cmd/Ctrl+W noticeably. An open sidebar holds a
// port, which keeps the page alive for as long as Arc is on screen.
browser.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});
