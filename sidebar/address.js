/* global ArcFox */
/* Arc-style address bar: shows the domain, edits the full URL, suggests tabs + history. */
import { h, setIcon } from "./ui.js";
import { resolve, pretty, runSearch, switchToTab, suggestFor, topSiteItems } from "./suggest.js";

/**
 * ctx: {
 *   windowId(), activeTab(),
 *   newTab(url?) -> Promise<tab>   opens a tab in the current space
 * }
 */
export function createAddressBar(ctx) {
  const box = document.getElementById("address");
  const input = document.getElementById("url");
  const lock = document.getElementById("lock");
  const copy = document.getElementById("copy-url");
  const list = document.getElementById("suggest");
  const addrIcon = document.getElementById("addr-icon");
  let newTabMode = false;
  let items = [];
  let selected = 0;
  let token = 0;
  let itemsFor = "";

  async function go(target) {
    // Extensions may not open Firefox's own pages (about:config, ...).
    if (/^about:/i.test(target.url || "") && !/^about:(blank|newtab|home)$/i.test(target.url)) {
      const key = navigator.platform.startsWith("Mac") ? "\u2318L" : "Ctrl+L";
      input.value = "";
      input.placeholder = `Firefox pages: press ${key}`;
      setTimeout(() => (input.placeholder = "Search or enter address"), 4000);
      return;
    }
    try {
      let tab = newTabMode ? null : ctx.activeTab();
      if (!tab) tab = await ctx.newTab(target.url);
      else if (target.url) await browser.tabs.update(tab.id, { url: target.url });
      if (target.search) await runSearch(tab.id, target.search);
    } catch (err) {
      console.error("ArcFox: navigation failed", err);
    }
  }

  /** Attach the action to a shared suggestion item. */
  const withRun = (item) => ({
    ...item,
    run: () => (item.tab ? switchToTab(item.tab, ctx.windowId()) : go(item.target)),
  });

  async function suggestions(text) {
    return (await suggestFor(text)).map(withRun);
  }

  /** Before typing: current page first (like Arc), then frequent sites. */
  async function showDefaults() {
    const mine = ++token;
    const out = [];
    const tab = newTabMode ? null : ctx.activeTab();
    if (tab && !ArcFox.isNewTabUrl(tab.url)) {
      out.push({ kind: "tab", icon: tab.favIconUrl, url: tab.url, label: tab.title || tab.url, sub: "Current tab", run: () => {} });
    }
    out.push(...(await topSiteItems({ exclude: tab?.url, max: 6 - out.length })).map(withRun));
    if (mine !== token || document.activeElement !== input) return;
    items = out;
    itemsFor = input.value.trim();
    selected = 0;
    renderList();
  }

  function renderList() {
    list.hidden = items.length === 0;
    list.replaceChildren(
      ...items.map((item, i) => {
        const icon = h("span", { className: "s-icon" });
        if (item.kind === "tab" || item.kind === "history") setIcon(icon, item.icon, item.url);
        else icon.textContent = item.kind === "search" ? "⌕" : "↗";
        const chip = h("span", { className: "s-chip" }, icon);
        return h(
          "li",
          {
            className: i === selected ? "selected" : "",
            onmouseenter: () => {
              selected = i;
              for (const [j, row] of [...list.children].entries()) row.classList.toggle("selected", j === i);
            },
            onmousedown: (e) => {
              e.preventDefault(); // keep focus until run
              run(item);
            },
          },
          chip,
          h("span", { className: "s-label" }, item.label),
          h("span", { className: "s-sub" }, item.sub)
        );
      })
    );
  }

  async function run(item) {
    const newTab = newTabMode;
    input.blur(); // resets newTabMode
    newTabMode = newTab;
    try {
      await item.run();
    } finally {
      newTabMode = false;
    }
  }

  async function update() {
    const text = input.value.trim();
    if (!text) {
      showDefaults();
      return;
    }
    const mine = ++token;
    const next = await suggestions(text);
    if (mine !== token || document.activeElement !== input) return;
    items = next;
    itemsFor = text;
    selected = 0;
    renderList();
  }

  let debounce = 0;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 60);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      // Suggestions may lag behind fast typing; fall back to the raw text.
      if (items[selected] && itemsFor === text) run(items[selected]);
      else if (text) run({ run: () => go(resolve(text)) });
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.blur();
    }
  });

  input.addEventListener("focus", () => {
    box.classList.add("editing");
    const tab = newTabMode ? null : ctx.activeTab();
    if (!newTabMode) input.value = tab && !ArcFox.isNewTabUrl(tab.url) ? tab.url : "";
    if (tab) setIcon(addrIcon, tab.favIconUrl, tab.url);
    else {
      addrIcon.dataset.src = "";
      addrIcon.textContent = "⌕";
    }
    input.select();
    showDefaults();
  });

  input.addEventListener("blur", () => {
    box.classList.remove("editing", "new-tab");
    newTabMode = false;
    items = [];
    token++;
    renderList();
    show(ctx.activeTab());
  });

  copy.addEventListener("click", async () => {
    const tab = ctx.activeTab();
    if (!tab) return;
    await navigator.clipboard.writeText(tab.url);
    copy.classList.add("done");
    setTimeout(() => copy.classList.remove("done"), 900);
  });

  function show(tab) {
    if (document.activeElement === input) return;
    input.value = tab ? pretty(tab.url) : "";
    input.title = tab?.url || "";
    const secure = !!tab && /^https:/i.test(tab.url);
    lock.classList.toggle("secure", secure);
    lock.title = secure ? "Secure connection" : "";
  }

  return {
    update: show,
    /** Focus the field; mode "new" opens the result in a new tab (Arc's New Tab). */
    focus(mode) {
      newTabMode = mode === "new";
      box.classList.toggle("new-tab", newTabMode);
      if (newTabMode) input.value = "";
      window.focus();
      input.focus();
      if (!newTabMode) input.select();
    },
  };
}
