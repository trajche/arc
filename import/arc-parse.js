/* Parse Arc's StorableSidebar.json (+ optional Chromium "Local State" for
 * profile names) into a plan for Arcsidebar.
 *
 * Arc stores Swift dictionaries as flat arrays: [key, value, key, value, ...].
 * The sidebar container holds:
 *   spaces              [id, space, ...]; space.containerIDs = ["pinned", id, "unpinned", id]
 *   items               [id, item, ...]; item.data is {tab}, {list} (folder),
 *                       {itemContainer}, {easel}, {arcDocument}; order = childrenIds
 *   topAppsContainerIDs [profile, containerId, ...]  favorites, per Arc profile
 * A space's profile is {default: true} or {custom: {_0: {directoryBasename}}}.
 */

const pairs = (arr = []) => {
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) out.push([arr[i], arr[i + 1]]);
  return out;
};

export const profileKey = (p) => p?.custom?._0?.directoryBasename || "Default";

// Firefox container colors (hue in degrees), nearest match for Arc's theme color.
const HUES = { red: 8, orange: 30, yellow: 50, green: 105, turquoise: 165, blue: 205, purple: 275, pink: 315 };

function nearestColor(rgb) {
  if (!rgb) return "purple";
  const { red: r = 0, green: g = 0, blue: b = 0 } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return "purple"; // near-grey theme
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  let best = "purple";
  let bestDist = 999;
  for (const [name, hue] of Object.entries(HUES)) {
    const d = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
    if (d < bestDist) [best, bestDist] = [name, d];
  }
  return best;
}

const isWebUrl = (url) => /^https?:\/\//i.test(url || "");

export function parseArc(sidebar, localState = null) {
  const container = sidebar?.sidebar?.containers?.find((c) => Array.isArray(c?.spaces));
  if (!container) throw new Error("This doesn't look like Arc's StorableSidebar.json.");

  const items = new Map(pairs(container.items).filter(([, o]) => o && typeof o === "object"));
  const names = localState?.profile?.info_cache || {};
  const skipped = { notes: 0, other: 0 };

  const tabOf = (o) => {
    const url = o.data.tab.savedURL;
    if (!isWebUrl(url)) return null;
    return { type: "tab", url, title: o.title || o.data.tab.savedTitle || url };
  };

  /** Pinned tree of a container: tabs and folders (nested folders flattened as "A / B"). */
  function walk(containerId) {
    const out = [];
    const visit = (id, prefix, into) => {
      const o = items.get(id);
      if (!o?.data) return;
      if (o.data.tab) {
        const tab = tabOf(o);
        if (tab) into.push(tab);
        else skipped.other++;
      } else if (o.data.list) {
        const name = prefix ? `${prefix} / ${o.title || "Folder"}` : o.title || "Folder";
        const folder = { type: "folder", name, children: [], nested: !!prefix };
        out.push(folder);
        for (const child of o.childrenIds || []) visit(child, name, folder.children);
      } else if (o.data.easel || o.data.arcDocument) {
        skipped.notes++;
      } else {
        skipped.other++;
      }
    };
    // Folders are added where they're found, so `out` keeps Arc's order.
    // Folders that only held other folders are dropped once flattened.
    for (const id of items.get(containerId)?.childrenIds || []) visit(id, "", out);
    return out.filter((x) => x.type === "tab" || x.children.length || !x.nested);
  }

  const profiles = new Map(); // key -> {key, name, spaces: n}
  const spaces = pairs(container.spaces).map(([, s]) => {
    const key = profileKey(s.profile);
    if (!profiles.has(key)) profiles.set(key, { key, name: names[key]?.name || key, spaces: 0 });
    profiles.get(key).spaces++;
    const containers = Object.fromEntries(pairs(s.containerIDs));
    const icon = s.customInfo?.iconType?.emoji_v2 || "";
    return {
      name: s.title || "Space",
      icon,
      color: nearestColor(s.customInfo?.windowTheme?.primaryColorPalette?.midTone),
      profile: key,
      pins: containers.pinned ? walk(containers.pinned) : [],
    };
  });

  // Favorites belong to an Arc profile (each profile has its own grid).
  const favorites = [];
  for (const [profile, id] of pairs(container.topAppsContainerIDs)) {
    const key = profileKey(profile);
    const seen = new Set();
    for (const child of items.get(id)?.childrenIds || []) {
      const o = items.get(child);
      const tab = o?.data?.tab && tabOf(o);
      if (tab && !seen.has(tab.url)) {
        seen.add(tab.url);
        favorites.push({ ...tab, profile: key });
      }
    }
  }

  return { profiles: [...profiles.values()], spaces, favorites, skipped };
}
