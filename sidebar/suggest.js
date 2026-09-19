/* global ArcFox */
/* Address/search suggestions shared by the sidebar address bar and the command bar. */

/** Turn typed text into {url} or {search}. */
export function resolve(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^(https?|file|ftp|about|view-source|moz-extension):/i.test(t)) return { url: t };
  if (!/\s/.test(t)) {
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t)) return { url: "http://" + t };
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(t)) return { url: "https://" + t };
  }
  return { search: t };
}

/** Domain for http(s) pages, the URL otherwise, "" for new-tab pages. */
export function pretty(url) {
  if (!url || ArcFox.isNewTabUrl(url)) return "";
  try {
    const u = new URL(url);
    if (/^https?:$/.test(u.protocol)) return u.hostname.replace(/^www\./, "");
  } catch {
    // keep as-is
  }
  return url;
}

export async function engineName() {
  try {
    return (await browser.search.get()).find((e) => e.isDefault)?.name || "the web";
  } catch {
    return "the web";
  }
}

export async function runSearch(tabId, text) {
  if (browser.search.query) await browser.search.query({ text, tabId });
  else await browser.search.search({ query: text, tabId });
}

export async function switchToTab(tab, fromWindowId) {
  await browser.tabs.update(tab.id, { active: true });
  if (tab.windowId !== fromWindowId) await browser.windows.update(tab.windowId, { focused: true });
}

/**
 * Suggestions for typed text, best first:
 *   {kind: "go"|"search"|"tab"|"history", label, sub, url?, icon?, tab?, target?}
 * `tab` items switch to that tab; the others navigate to `target` ({url} or {search}).
 */
export async function suggestFor(text, { max = 12 } = {}) {
  const out = [];
  const r = resolve(text);
  if (r?.url) out.push({ kind: "go", label: pretty(r.url) || r.url, sub: "Open", target: r });
  out.push({ kind: "search", label: text, sub: "Search", target: { search: text } });

  const q = text.toLowerCase();
  const seen = new Set();
  const tabs = (await browser.tabs.query({}))
    .filter((t) => !t.active && ((t.title || "").toLowerCase().includes(q) || (t.url || "").toLowerCase().includes(q)))
    .slice(0, 4);
  for (const t of tabs) {
    seen.add(t.url);
    out.push({ kind: "tab", tab: t, icon: t.favIconUrl, url: t.url, label: t.title || t.url, sub: "Switch to Tab" });
  }

  const history = await browser.history.search({ text, maxResults: 25, startTime: 0 }).catch(() => []);
  history.sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
  for (const item of history) {
    if (seen.has(item.url) || out.length >= max) continue;
    seen.add(item.url);
    out.push({ kind: "history", url: item.url, label: item.title || item.url, sub: pretty(item.url), target: { url: item.url } });
  }
  return out;
}

/** Frequently visited sites, for the empty state. */
export async function topSiteItems({ exclude = null, max = 6 } = {}) {
  const sites = await browser.topSites.get({ limit: max + 2, includeFavicon: true }).catch(() => []);
  return sites
    .filter((s) => s.url !== exclude)
    .slice(0, max)
    .map((s) => ({ kind: "history", icon: s.favicon, url: s.url, label: s.title || pretty(s.url), sub: pretty(s.url), target: { url: s.url } }));
}
