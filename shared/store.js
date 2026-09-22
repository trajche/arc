/* Shared data layer, loaded by both the background page and the sidebar.
 *
 * storage.local (was storage.sync until 0.4: too small for big Arc imports;
 * old sync data is copied over once and left in place as a backup)
 *   favorites        [{id, url, title, icon}]          favorites of spaces without a container
 *   favorites@<cookieStoreId>                          favorites of spaces in that container
 *                    (like Arc profiles: spaces sharing a container share favorites)
 *   spaces           [{id, name, icon, color, container}]
 *   pins:<spaceId>   [{id, url, title, icon, parent?} | {id, type: "folder", name, open, parent?}]
 *                    pinned items + folders of one space, flat and ordered; an item's
 *                    `parent` is the id of the folder it's in
 *   Lists over the 8KB per-key quota continue in "<key>#1", "<key>#2", ...
 * storage.local
 *   faviconCache     {itemId: url}
 * session values (survive restarts)
 *   tab    arcfoxFav    id of the favorite / pinned item the tab belongs to
 *   tab    arcfoxSpace  space the tab lives in
 *   window arcfoxSpace  active space of the window
 *   window arcfoxLast   {spaceId: tabId} last active tab per space
 */
"use strict";

// eslint-disable-next-line no-unused-vars
const ArcFox = (() => {
  const FAV_KEY = "favorites";
  const SPACES_KEY = "spaces";
  const PIN_PREFIX = "pins:";
  const ICON_KEY = "faviconCache";
  const ITEM_VALUE = "arcfoxFav"; // name kept so bindings from 0.1.x survive
  const SPACE_VALUE = "arcfoxSpace";
  const LAST_VALUE = "arcfoxLast";

  // Firefox container colors, reused for spaces so a space matches its container.
  const COLORS = {
    blue: "#37adff",
    turquoise: "#00c79a",
    green: "#51cd00",
    yellow: "#ffcb00",
    orange: "#ff9f00",
    red: "#ff613d",
    pink: "#ff4bda",
    purple: "#af51f5",
  };

  const DEFAULT_SPACE = { id: "default", name: "Personal", icon: "", color: "purple", container: null };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const isFavoritable = (url) => /^https?:\/\//i.test(url || "");
  // Firefox's new-tab pages, plus Arc's own (new-tab page, full-page command bar).
  const isNewTabUrl = (url) =>
    url === "about:newtab" || url === "about:home" || /^moz-extension:\/\/[^/]+\/(newtab|palette)\//.test(url || "");
  // Only short http(s) favicon URLs go to sync storage (8KB per-item quota).
  const syncableIcon = (url) => (url && /^https?:/i.test(url) && url.length < 512 ? url : "");
  const pinKey = (spaceId) => PIN_PREFIX + spaceId;
  /** Favorites list of a space: per container, like Arc's per-profile favorites. */
  const favKey = (space) => (space?.container ? `${FAV_KEY}@${space.container}` : FAV_KEY);
  const isFavKey = (key) => key === FAV_KEY || key.startsWith(`${FAV_KEY}@`);
  const spaceOfKey = (key) => (key.startsWith(PIN_PREFIX) ? key.slice(PIN_PREFIX.length) : null);

  const isFolder = (item) => item?.type === "folder";

  function insertBefore(list, item, beforeId) {
    const at = beforeId ? list.findIndex((i) => i.id === beforeId) : -1;
    if (at >= 0) list.splice(at, 0, item);
    else list.push(item);
  }

  /** Insert before `beforeId`, else at the end of folder `parent`, else at the end. */
  function insertInto(list, item, beforeId, parent) {
    if (beforeId || !parent) return insertBefore(list, item, beforeId);
    let at = -1;
    list.forEach((x, i) => {
      if (x.id === parent || x.parent === parent) at = i;
    });
    list.splice(at + 1, 0, item);
  }

  function notify() {
    browser.runtime.sendMessage({ type: "arcfox:changed" }).catch(() => {});
  }

  /* ---------- Storage ---------- */

  const DATA = browser.storage.local;
  // Lists are split across numbered keys (a leftover from storage.sync's 8KB
  // per-key limit; harmless in local storage and keeps the format stable).
  const CHUNK_BYTES = 7000;

  function readList(all, key) {
    const list = Array.isArray(all[key]) ? [...all[key]] : [];
    for (let i = 1; Array.isArray(all[`${key}#${i}`]); i++) list.push(...all[`${key}#${i}`]);
    return list;
  }

  /** Write lists ({key: list}) in chunks and drop chunks no longer needed. */
  async function writeLists(entries) {
    stateCache = null;
    const existing = Object.keys(await DATA.get(null));
    const set = {};
    const remove = [];
    for (const [key, list] of Object.entries(entries)) {
      const chunks = [[]];
      let size = 2;
      for (const item of list) {
        const n = JSON.stringify(item).length + 1;
        if (size + n > CHUNK_BYTES && chunks.at(-1).length) {
          chunks.push([]);
          size = 2;
        }
        chunks.at(-1).push(item);
        size += n;
      }
      chunks.forEach((chunk, i) => (set[i ? `${key}#${i}` : key] = chunk));
      for (const k of existing) {
        const n = k.startsWith(`${key}#`) ? Number(k.slice(key.length + 1)) : 0;
        if (n >= chunks.length) remove.push(k);
      }
    }
    await DATA.set(set);
    if (remove.length) await DATA.remove(remove);
  }

  const writeList = (key, list) => writeLists({ [key]: list });

  // Reading every key and rebuilding the state is the sidebar's hot path (it
  // refreshes on each tab event), so keep the last result until something
  // changes. storage.onChanged fires in this context too, including for our
  // own writes.
  let stateCache = null;
  let iconCache = null;

  browser.storage.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (key === ICON_KEY) iconCache = null;
      else if (key === SPACES_KEY || key.startsWith(FAV_KEY) || key.startsWith(PIN_PREFIX)) stateCache = null;
    }
  });

  async function getState() {
    if (stateCache) return stateCache;
    let all = await DATA.get(null);
    if (!(SPACES_KEY in all)) {
      // One-time move from storage.sync (Arc before 0.4).
      const old = await browser.storage.sync.get(null).catch(() => ({}));
      const keep = Object.fromEntries(
        Object.entries(old).filter(([k]) => k === SPACES_KEY || k.startsWith(FAV_KEY) || k.startsWith(PIN_PREFIX))
      );
      if (keep[SPACES_KEY]) {
        await DATA.set(keep);
        all = await DATA.get(null);
      }
    }
    let spaces = Array.isArray(all[SPACES_KEY]) && all[SPACES_KEY].length ? all[SPACES_KEY] : null;
    if (!spaces) {
      // Fixed id, so concurrent first runs (background + sidebar) agree.
      spaces = [{ ...DEFAULT_SPACE }];
      stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    }
    const pins = new Map(spaces.map((s) => [s.id, readList(all, pinKey(s.id))]));
    const favLists = new Map([[FAV_KEY, readList(all, FAV_KEY)]]);
    for (const key of Object.keys(all)) {
      if (key.startsWith(`${FAV_KEY}@`) && !key.includes("#")) favLists.set(key, readList(all, key));
    }
    // `favorites`: every favorite in every list (for "is this a favorite?" checks).
    const favorites = [...favLists.values()].flat();
    stateCache = { favorites, favLists, spaces, pins };
    return stateCache;
  }

  function listFor(state, key) {
    if (isFavKey(key)) return state.favLists?.get(key) || (key === FAV_KEY ? state.favorites : []);
    return state.pins.get(spaceOfKey(key)) || [];
  }

  function findItem(state, itemId) {
    for (const [key, list] of state.favLists || [[FAV_KEY, state.favorites]]) {
      const fav = list.find((f) => f.id === itemId);
      if (fav) return { key, spaceId: null, list, item: fav };
    }
    for (const [spaceId, list] of state.pins) {
      const item = list.find((i) => i.id === itemId);
      if (item) return { key: pinKey(spaceId), spaceId, list, item };
    }
    return null;
  }

  const allItemIds = (state) =>
    new Set([...state.favorites, ...[...state.pins.values()].flat()].map((i) => i.id));

  async function getIconCache() {
    if (iconCache) return iconCache;
    const { [ICON_KEY]: cache } = await browser.storage.local.get(ICON_KEY);
    iconCache = cache && typeof cache === "object" ? cache : {};
    return iconCache;
  }

  async function cacheIcon(itemId, url) {
    if (!url || !/^(https?:|data:image\/)/i.test(url)) return;
    const cache = await getIconCache();
    if (cache[itemId] === url) return;
    cache[itemId] = url;
    iconCache = null;
    await browser.storage.local.set({ [ICON_KEY]: cache });
  }

  async function dropIcon(itemId) {
    const cache = await getIconCache();
    if (!(itemId in cache)) return;
    delete cache[itemId];
    iconCache = null;
    await browser.storage.local.set({ [ICON_KEY]: cache });
  }

  /* ---------- Session values ---------- */

  async function tabValue(tabId, key) {
    try {
      return await browser.sessions.getTabValue(tabId, key);
    } catch {
      return undefined;
    }
  }

  async function windowValue(windowId, key) {
    try {
      return await browser.sessions.getWindowValue(windowId, key);
    } catch {
      return undefined;
    }
  }

  const getTabItem = (tabId) => tabValue(tabId, ITEM_VALUE);
  const getTabSpace = (tabId) => tabValue(tabId, SPACE_VALUE);
  const setTabItem = (tabId, itemId) => browser.sessions.setTabValue(tabId, ITEM_VALUE, itemId);
  const setTabSpace = (tabId, spaceId) => browser.sessions.setTabValue(tabId, SPACE_VALUE, spaceId);

  async function clearTabItem(tabId) {
    try {
      await browser.sessions.removeTabValue(tabId, ITEM_VALUE);
    } catch {
      // tab already gone
    }
  }

  /**
   * Read item bindings and spaces for the given tabs.
   * Duplicated tabs inherit session values: the oldest binding wins, the rest
   * are released. Bindings to deleted items are released too.
   */
  async function scanTabs(tabs, state) {
    const known = allItemIds(state);
    const metas = await Promise.all(
      tabs.map(async (t) => [t, await getTabItem(t.id), await getTabSpace(t.id)])
    );
    metas.sort((a, b) => a[0].id - b[0].id);
    const bound = new Map(); // itemId -> tab
    const tabItem = new Map(); // tabId -> itemId
    const tabSpace = new Map(); // tabId -> spaceId
    for (const [tab, itemId, spaceId] of metas) {
      if (spaceId) tabSpace.set(tab.id, spaceId);
      if (!itemId) continue;
      if (!known.has(itemId) || bound.has(itemId)) {
        clearTabItem(tab.id);
        continue;
      }
      bound.set(itemId, tab);
      tabItem.set(tab.id, itemId);
    }
    return { bound, tabItem, tabSpace };
  }

  async function findBoundTab(state, itemId) {
    return (await scanTabs(await browser.tabs.query({}), state)).bound.get(itemId) || null;
  }

  /* ---------- Spaces & windows ---------- */

  async function getWindowSpace(windowId, state) {
    const id = await windowValue(windowId, SPACE_VALUE);
    return state.spaces.some((s) => s.id === id) ? id : state.spaces[0].id;
  }

  async function rememberActive(windowId, spaceId, tabId) {
    const last = (await windowValue(windowId, LAST_VALUE)) || {};
    if (last[spaceId] === tabId) return;
    last[spaceId] = tabId;
    await browser.sessions.setWindowValue(windowId, LAST_VALUE, last);
  }

  async function createTabInSpace(windowId, space, { url, active = true, index } = {}) {
    const opts = { windowId, active };
    if (url) opts.url = url;
    if (index !== undefined) opts.index = index;
    if (space.container) opts.cookieStoreId = space.container;
    let tab;
    try {
      tab = await browser.tabs.create(opts);
    } catch (err) {
      if (!opts.cookieStoreId) throw err;
      delete opts.cookieStoreId; // container was deleted
      tab = await browser.tabs.create(opts);
    }
    await setTabSpace(tab.id, space.id);
    return tab;
  }

  /** Split a window's tabs into the ones visible in `spaceId` and the rest. */
  async function computeVisibility(windowId, state, spaceId) {
    const tabs = await browser.tabs.query({ windowId });
    const { tabItem, tabSpace } = await scanTabs(tabs, state);
    const favIds = new Set(state.favorites.map((f) => f.id));
    const spaceIds = new Set(state.spaces.map((s) => s.id));
    const mine = []; // tabs of the space (not favorites)
    const show = [];
    const hide = [];
    for (const t of tabs) {
      if (favIds.has(tabItem.get(t.id))) {
        show.push(t.id);
        continue;
      }
      const s = tabSpace.get(t.id);
      if (!s || !spaceIds.has(s) || s === spaceId) {
        mine.push(t);
        show.push(t.id);
      } else {
        hide.push(t.id);
      }
    }
    return { tabs, mine, show, hide };
  }

  async function switchSpace(windowId, spaceId) {
    const state = await getState();
    const space = state.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    // Set first so the background's onActivated sees the new space.
    await browser.sessions.setWindowValue(windowId, SPACE_VALUE, spaceId);
    const { mine, show, hide } = await computeVisibility(windowId, state, spaceId);
    const last = (await windowValue(windowId, LAST_VALUE)) || {};
    let target =
      mine.find((t) => t.id === last[spaceId]) ||
      mine.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (show.length) await browser.tabs.show(show);
    if (target) await browser.tabs.update(target.id, { active: true });
    else target = await createTabInSpace(windowId, space);
    const toHide = hide.filter((id) => id !== target.id);
    if (toHide.length) await browser.tabs.hide(toHide).catch(() => {});
    notify();
  }

  /** Re-apply hidden/shown state, following the active tab if it lives in another space. */
  async function syncVisibility(windowId) {
    const state = await getState();
    let spaceId = await getWindowSpace(windowId, state);
    const [active] = await browser.tabs.query({ windowId, active: true });
    if (active) {
      const s = await getTabSpace(active.id);
      const itemId = await getTabItem(active.id);
      const isFav = state.favorites.some((f) => f.id === itemId);
      if (s && s !== spaceId && !isFav && state.spaces.some((x) => x.id === s)) {
        spaceId = s;
        await browser.sessions.setWindowValue(windowId, SPACE_VALUE, spaceId);
      }
    }
    const { show, hide } = await computeVisibility(windowId, state, spaceId);
    if (show.length) await browser.tabs.show(show);
    const toHide = hide.filter((id) => id !== active?.id);
    if (toHide.length) await browser.tabs.hide(toHide).catch(() => {});
    notify();
  }

  async function saveSpace(space) {
    const state = await getState();
    const spaces = state.spaces.slice();
    const at = space.id ? spaces.findIndex((s) => s.id === space.id) : -1;
    let saved;
    if (at >= 0) spaces[at] = saved = { ...spaces[at], ...space };
    else spaces.push((saved = { ...space, id: uid() }));
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    notify();
    return saved;
  }

  async function moveSpace(spaceId, beforeSpaceId) {
    if (spaceId === beforeSpaceId) return;
    const state = await getState();
    const spaces = state.spaces.filter((s) => s.id !== spaceId);
    const space = state.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    insertBefore(spaces, space, beforeSpaceId);
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    notify();
  }

  /** Tabs (all windows) that live in a space, excluding favorites. */
  async function spaceTabs(spaceId) {
    const state = await getState();
    const tabs = await browser.tabs.query({});
    const { tabItem, tabSpace } = await scanTabs(tabs, state);
    const favIds = new Set(state.favorites.map((f) => f.id));
    return tabs.filter((t) => tabSpace.get(t.id) === spaceId && !favIds.has(tabItem.get(t.id)));
  }

  /** Delete a space and close its tabs. The last space cannot be deleted. */
  async function deleteSpace(spaceId) {
    const state = await getState();
    const rest = state.spaces.filter((s) => s.id !== spaceId);
    if (!rest.length || rest.length === state.spaces.length) return false;
    const doomed = (await spaceTabs(spaceId)).map((t) => t.id);
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: rest });
    await writeList(pinKey(spaceId), []);
    stateCache = null;
    await DATA.remove(pinKey(spaceId));
    for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
      if ((await windowValue(win.id, SPACE_VALUE)) === spaceId) await switchSpace(win.id, rest[0].id);
    }
    if (doomed.length) await browser.tabs.remove(doomed);
    notify();
    return true;
  }

  /** Move a tab to another space. Reopens it when the space uses a different container. */
  async function moveTabToSpace(tabId, spaceId) {
    const state = await getState();
    const space = state.spaces.find((s) => s.id === spaceId);
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!space || !tab) return;
    const itemId = await getTabItem(tabId);
    const found = itemId && findItem(state, itemId);
    let moved = tabId;
    if (found) {
      if (isFavKey(found.key)) return; // favorites belong to a container, not a space
      await moveItem(itemId, pinKey(spaceId));
    } else if (
      space.container &&
      tab.cookieStoreId !== space.container &&
      (isFavoritable(tab.url) || isNewTabUrl(tab.url))
    ) {
      // A different container means the tab is reopened there.
      const replacement = await createTabInSpace(tab.windowId, space, {
        url: isFavoritable(tab.url) ? tab.url : undefined,
        active: false,
        index: tab.index + 1,
      });
      moved = replacement.id;
      await browser.tabs.remove(tabId);
    } else {
      await setTabSpace(tabId, spaceId);
    }
    // Follow the tab into its new space (Arc does the same).
    await rememberActive(tab.windowId, spaceId, moved);
    await switchSpace(tab.windowId, spaceId);
    await browser.tabs.update(moved, { active: true }).catch(() => {});
  }

  /** Give a freshly created tab a space; reopen new-tab pages in the space's container. */
  async function adoptTab(tabId) {
    if ((await getTabItem(tabId)) || (await getTabSpace(tabId))) return;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.incognito) return; // private tabs belong to no space
    const state = await getState();
    let spaceId = tab.openerTabId !== undefined ? await getTabSpace(tab.openerTabId) : null;
    if (!state.spaces.some((s) => s.id === spaceId)) spaceId = await getWindowSpace(tab.windowId, state);
    const space = state.spaces.find((s) => s.id === spaceId);
    if (
      space.container &&
      tab.cookieStoreId !== space.container &&
      tab.openerTabId === undefined &&
      isNewTabUrl(tab.url)
    ) {
      await createTabInSpace(tab.windowId, space, { active: tab.active, index: tab.index });
      await browser.tabs.remove(tab.id);
      return;
    }
    await setTabSpace(tab.id, spaceId);
    notify();
  }

  /** Arc has no native pinned tabs: turn one into a pinned item of its space. */
  async function convertNativePin(tab) {
    await browser.tabs.update(tab.id, { pinned: false }).catch(() => {});
    const state = await getState();
    const itemId = await getTabItem(tab.id);
    if ((itemId && findItem(state, itemId)) || !isFavoritable(tab.url)) return;
    const spaceId = (await getTabSpace(tab.id)) || (await getWindowSpace(tab.windowId, state));
    await addItem(pinKey(spaceId), tab);
  }

  /**
   * Drop blank new-tab / command-bar pages from Firefox's recently closed list,
   * so Cmd/Ctrl+Shift+T and the Archive bring back real tabs.
   */
  async function forgetBlankClosedTabs() {
    const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
    for (const entry of closed) {
      if (!entry.tab || !isNewTabUrl(entry.tab.url)) continue;
      await browser.sessions.forgetClosedTab(entry.tab.windowId, entry.tab.sessionId).catch(() => {});
    }
  }

  /* ---------- Import (from Arc) ---------- */

  // Site icon until the tab has been opened once (then the real favicon is cached).
  const guessIcon = (url) => {
    try {
      return new URL("/favicon.ico", url).href;
    } catch {
      return "";
    }
  };

  /**
   * Add imported spaces, their pinned items/folders, and favorites in one write.
   * spaces: [{name, icon, color, container, ownContainer,
   *           pins: [{type: "tab", url, title} | {type: "folder", name, children: [tab]}]}]
   * favorites: [{url, title, container}] (container null = no container)
   * replace: drop the current spaces, pins and favorites first (re-importing).
   * If the current setup is still the untouched default (one empty space, no
   * favorites), the imported spaces replace it.
   */
  async function importSpaces({ spaces, favorites = [], replace = false }) {
    let state = await getState();
    if (replace && spaces.length) {
      const old = [...state.favLists.keys(), ...state.spaces.map((sp) => pinKey(sp.id))];
      await writeLists(Object.fromEntries(old.map((k) => [k, []])));
      stateCache = null;
      await DATA.remove(old);
      state = await getState();
    }
    const pristine =
      (replace && spaces.length) ||
      (state.spaces.length === 1 && !state.favorites.length && !(state.pins.get(state.spaces[0].id) || []).length);
    const item = (t, parent) => ({ id: uid(), url: t.url, title: t.title, icon: guessIcon(t.url), ...(parent ? { parent } : {}) });
    const newSpaces = [];
    const writes = {};
    let count = 0;
    for (const sp of spaces) {
      const id = uid();
      newSpaces.push({ id, name: sp.name, icon: sp.icon || "", color: sp.color, container: sp.container || null, ownContainer: !!sp.ownContainer });
      const list = [];
      for (const x of sp.pins) {
        if (x.type === "tab") list.push(item(x));
        else {
          const folder = { id: uid(), type: "folder", name: x.name, open: false };
          list.push(folder, ...x.children.map((c) => item(c, folder.id)));
        }
      }
      count += list.filter((i) => !isFolder(i)).length;
      writes[pinKey(id)] = list;
    }
    let addedFavs = 0;
    for (const f of favorites) {
      const key = favKey({ container: f.container });
      writes[key] ??= [...listFor(state, key)];
      if (writes[key].some((x) => x.url === f.url)) continue;
      writes[key].push(item(f));
      addedFavs++;
    }
    await writeLists(writes);
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: pristine && newSpaces.length ? newSpaces : [...state.spaces, ...newSpaces] });
    if (pristine && newSpaces.length) {
      stateCache = null;
      await DATA.remove(state.spaces.map((sp) => pinKey(sp.id)));
      // Open tabs from the replaced spaces move to the first imported one;
      // their pinned/favorite bindings are gone with the old lists.
      const oldIds = new Set(state.spaces.map((sp) => sp.id));
      for (const tab of await browser.tabs.query({})) {
        if (oldIds.has(await getTabSpace(tab.id))) await setTabSpace(tab.id, newSpaces[0].id);
      }
      for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) await switchSpace(win.id, newSpaces[0].id);
    }
    notify();
    return { spaces: newSpaces.length, pins: count, favorites: addedFavs, replacedDefault: pristine };
  }

  /* ---------- Favorites & pinned items ---------- */

  async function openItem(itemId, windowId) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found || isFolder(found.item)) return null;
    const tab = await findBoundTab(state, itemId);
    if (tab) {
      await browser.tabs.update(tab.id, { active: true });
      if (tab.windowId !== windowId) await browser.windows.update(tab.windowId, { focused: true });
      return tab;
    }
    const space = found.spaceId && state.spaces.find((s) => s.id === found.spaceId);
    const container = !space && found.key.startsWith(`${FAV_KEY}@`) ? found.key.slice(FAV_KEY.length + 1) : null;
    const created = space
      ? await createTabInSpace(windowId, space, { url: found.item.url })
      : await browser.tabs
          .create({ url: found.item.url, windowId, active: true, ...(container ? { cookieStoreId: container } : {}) })
          .catch(() => browser.tabs.create({ url: found.item.url, windowId, active: true })); // container gone
    await setTabItem(created.id, itemId);
    notify();
    return created;
  }

  /** Turn a tab into a favorite (key = FAV_KEY) or pinned item (key = pinKey(space)). */
  async function addItem(key, tab, beforeId = null, { parent = null } = {}) {
    if (!tab || !isFavoritable(tab.url)) return null;
    const state = await getState();
    const existing = await getTabItem(tab.id);
    if (existing && findItem(state, existing)) {
      await moveItem(existing, key, beforeId, { parent });
      return findItem(state, existing).item;
    }
    const item = { id: uid(), url: tab.url, title: tab.title || tab.url, icon: syncableIcon(tab.favIconUrl) };
    if (parent && !isFavKey(key)) item.parent = parent;
    const list = listFor(state, key).slice();
    insertInto(list, item, beforeId, item.parent);
    await writeList(key, list);
    await setTabItem(tab.id, item.id);
    const spaceId = spaceOfKey(key);
    if (spaceId) await setTabSpace(tab.id, spaceId);
    await cacheIcon(item.id, tab.favIconUrl);
    notify();
    return item;
  }

  /**
   * Reorder an item, move it between favorites and a space's pinned list, or
   * in/out of a folder (`parent`: folder id, or null for top level).
   * Folders only live in pinned lists and don't nest.
   */
  async function moveItem(itemId, toKey, beforeId = null, { parent = null } = {}) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found || itemId === beforeId) return;
    if (isFolder(found.item) && (isFavKey(toKey) || parent)) return;
    const item = { ...found.item };
    if (parent && !isFavKey(toKey)) item.parent = parent;
    else delete item.parent;
    const from = found.list.filter((i) => i.id !== itemId);
    // A folder carries its items along when it moves to another space.
    const children = isFolder(item) && found.key !== toKey ? from.filter((i) => i.parent === itemId) : [];
    const fromRest = children.length ? from.filter((i) => i.parent !== itemId) : from;
    if (found.key === toKey) {
      insertInto(from, item, beforeId, item.parent);
      await writeList(toKey, from);
    } else {
      const to = listFor(state, toKey).slice();
      insertInto(to, item, beforeId, item.parent);
      to.splice(to.indexOf(item) + 1, 0, ...children);
      await writeLists({ [found.key]: fromRest, [toKey]: to });
      const spaceId = spaceOfKey(toKey);
      const tab = spaceId && (await findBoundTab(state, itemId));
      if (tab) await setTabSpace(tab.id, spaceId);
    }
    notify();
  }

  /** Remove an item. Its tab (if open) stays open as a regular tab. */
  async function removeItem(itemId, spaceIdForTab = null) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found) return null;
    const tab = await findBoundTab(state, itemId);
    if (tab) {
      await clearTabItem(tab.id);
      const spaceId =
        spaceIdForTab || found.spaceId || (await getTabSpace(tab.id)) || (await getWindowSpace(tab.windowId, state));
      await setTabSpace(tab.id, spaceId);
    }
    await writeList(found.key, found.list.filter((i) => i.id !== itemId));
    await dropIcon(itemId);
    notify();
    return tab;
  }

  /** Navigate the item's tab back to its saved URL. */
  async function resetItem(itemId) {
    const state = await getState();
    const found = findItem(state, itemId);
    const tab = found && (await findBoundTab(state, itemId));
    if (tab) await browser.tabs.update(tab.id, { url: found.item.url });
  }

  /** Save the item tab's current page as the item's URL. */
  async function saveCurrentUrl(itemId) {
    const state = await getState();
    const found = findItem(state, itemId);
    const tab = found && (await findBoundTab(state, itemId));
    if (!tab || !isFavoritable(tab.url)) return;
    const updated = {
      ...found.item,
      url: tab.url,
      title: tab.title || tab.url,
      icon: syncableIcon(tab.favIconUrl) || found.item.icon,
    };
    await writeList(found.key, found.list.map((i) => (i.id === itemId ? updated : i)));
    await cacheIcon(itemId, tab.favIconUrl);
  }

  /* ---------- Folders (pinned section) ---------- */

  /**
   * New folder in a space's pinned list holding existing pinned items
   * (`itemIds`) and/or open tabs (`tabIds`, pinned on the way in). It takes the
   * place of the first selected pinned item, or goes to the end.
   */
  async function createFolder(spaceId, { name = "New Folder", itemIds = [], tabIds = [] } = {}) {
    const state = await getState();
    const key = pinKey(spaceId);
    const list = listFor(state, key).slice();
    const folder = { id: uid(), type: "folder", name, open: true };
    const picked = new Set(itemIds);
    const moved = list.filter((i) => picked.has(i.id) && !isFolder(i));
    const firstAt = list.findIndex((i) => moved.includes(i));
    const rest = list.filter((i) => !moved.includes(i));
    const inside = moved.map((i) => ({ ...i, parent: folder.id }));

    // Tabs: reuse their existing item if they already have one, else pin them.
    for (const tabId of tabIds) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab || !isFavoritable(tab.url)) continue;
      const bound = await getTabItem(tab.id);
      if (bound && findItem(state, bound)) continue;
      const item = { id: uid(), url: tab.url, title: tab.title || tab.url, icon: syncableIcon(tab.favIconUrl), parent: folder.id };
      inside.push(item);
      await setTabItem(tab.id, item.id);
      await setTabSpace(tab.id, spaceId);
      await cacheIcon(item.id, tab.favIconUrl);
    }
    const at = firstAt >= 0 ? rest.indexOf(list.slice(firstAt).find((i) => rest.includes(i))) : -1;
    if (at >= 0) rest.splice(at, 0, folder, ...inside);
    else rest.push(folder, ...inside);
    await writeList(key, rest);
    notify();
    return folder;
  }

  async function updateFolder(folderId, patch) {
    const state = await getState();
    const found = findItem(state, folderId);
    if (!found || !isFolder(found.item)) return;
    const list = found.list.map((i) => (i.id === folderId ? { ...i, ...patch } : i));
    await writeList(found.key, list);
    notify();
  }

  /** Remove a folder; its items move to the top level (keepItems) or are removed too. */
  async function deleteFolder(folderId, { keepItems = true } = {}) {
    const state = await getState();
    const found = findItem(state, folderId);
    if (!found || !isFolder(found.item)) return;
    const children = found.list.filter((i) => i.parent === folderId);
    if (!keepItems) {
      const tabs = await browser.tabs.query({});
      const { bound } = await scanTabs(tabs, state);
      for (const child of children) {
        const tab = bound.get(child.id);
        if (tab) {
          await clearTabItem(tab.id);
          await setTabSpace(tab.id, found.spaceId);
        }
        await dropIcon(child.id);
      }
    }
    const list = found.list
      .filter((i) => i.id !== folderId && (keepItems || i.parent !== folderId))
      .map((i) => {
        if (i.parent !== folderId) return i;
        const { parent, ...rest } = i;
        return rest;
      });
    await writeList(found.key, list);
    notify();
  }

  return {
    FAV_KEY,
    favKey,
    isFavKey,
    SPACES_KEY,
    PIN_PREFIX,
    ICON_KEY,
    COLORS,
    pinKey,
    isFavoritable,
    isNewTabUrl,
    notify,
    getState,
    findItem,
    getIconCache,
    cacheIcon,
    getTabItem,
    getTabSpace,
    setTabSpace,
    scanTabs,
    getWindowSpace,
    rememberActive,
    createTabInSpace,
    switchSpace,
    syncVisibility,
    saveSpace,
    moveSpace,
    spaceTabs,
    deleteSpace,
    moveTabToSpace,
    adoptTab,
    convertNativePin,
    forgetBlankClosedTabs,
    importSpaces,
    openItem,
    addItem,
    moveItem,
    removeItem,
    resetItem,
    saveCurrentUrl,
    isFolder,
    createFolder,
    updateFolder,
    deleteFolder,
  };
})();
