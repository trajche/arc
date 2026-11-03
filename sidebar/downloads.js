/* Downloads tray: one row per download, with live progress, like Arc's sidebar.
   Firefox only fires downloads.onChanged for state changes — the byte counters
   come from polling downloads.search() while something is moving. */
import { h, lucide, showMenu, syncChildren } from "./ui.js";

const POLL_MS = 500;
const DONE_LINGER_MS = 60000; // a finished row sticks around this long, then goes

const ICONS = {
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  check: "M20 6 9 17l-5-5",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  pause: "M10 4H6v16h4zM18 4h-4v16h4z",
  play: "M6 4l14 8-14 8z",
  retry: "M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5",
  folder: "M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z",
  x: "M18 6L6 18M6 6l12 12",
};

/* Firefox reports a paused download as state "interrupted" with paused: true
   and error USER_CANCELED, so "is it still going" can't be read off state. */
const isMoving = (item) => item.state === "in_progress" && !item.paused;
const isPaused = (item) => !!item.paused && item.state !== "complete";
const isFailed = (item) => item.state === "interrupted" && !item.paused;
const inFlight = (item) => isMoving(item) || isPaused(item);

function fileName(item) {
  const path = item.filename || "";
  const base = path.split(/[\\/]/).pop();
  if (base) return base;
  try {
    return decodeURIComponent(new URL(item.url).pathname.split("/").pop()) || item.url;
  } catch {
    return item.url || "Download";
  }
}

function bytes(n) {
  if (!(n > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** "3.6/10.0 MB" when both fit the same unit — the sidebar is narrow. */
function progressText(got, total) {
  if (!total) return bytes(got);
  const a = bytes(got);
  const b = bytes(total);
  const unit = b.slice(b.indexOf(" ") + 1);
  return a.endsWith(unit) ? `${a.slice(0, a.indexOf(" "))}/${b}` : `${a} of ${b}`;
}

/**
 * Downloads tray.
 * ctx: { el, isPrivate() }
 */
export function createDownloads(ctx) {
  const items = new Map(); // id -> DownloadItem
  const dismissed = new Set(); // ids the user cleared from the tray
  const rows = new Map(); // id -> element
  const rates = new Map(); // id -> { at, bytes, rate }
  const finishedAt = new Map(); // id -> when it left in_progress
  let timer = 0;
  let canOpen = false;

  const list = h("ul", { className: "dl-list" });
  const clear = h(
    "button",
    { className: "link-btn", title: "Clear finished downloads", onclick: clearFinished },
    "Clear"
  );
  const head = h(
    "div",
    { className: "dl-head" },
    h("span", { className: "dl-head-title" }, "Downloads"),
    h("span", { className: "dl-head-count" }),
    clear
  );
  ctx.el.replaceChildren(head, list);
  ctx.el.hidden = true;

  /* ---------- Data ---------- */

  function mine(item) {
    return !dismissed.has(item.id) && !!item.incognito === !!ctx.isPrivate();
  }

  function visible() {
    return [...items.values()]
      .filter(mine)
      .sort((a, b) => Number(inFlight(b)) - Number(inFlight(a)) || (b.startTime < a.startTime ? -1 : 1));
  }

  function note(item) {
    items.set(item.id, item);
    // Only a download that is really over starts its countdown out of the tray.
    if (inFlight(item)) finishedAt.delete(item.id);
    else if (!finishedAt.has(item.id)) finishedAt.set(item.id, Date.now());
  }

  function forget(id) {
    items.delete(id);
    rates.delete(id);
    finishedAt.delete(id);
    rows.delete(id);
  }

  function clearFinished() {
    for (const item of items.values()) if (!inFlight(item)) dismissed.add(item.id);
    render();
  }

  /** Expire rows that finished a while ago so the tray doesn't become history. */
  function expire() {
    const cutoff = Date.now() - DONE_LINGER_MS;
    for (const [id, at] of finishedAt) if (at < cutoff) dismissed.add(id);
  }

  async function poll() {
    const found = await browser.downloads.search({ state: "in_progress" }).catch(() => []);
    const seen = new Set();
    for (const item of found) {
      seen.add(item.id);
      track(item);
      note(item);
    }
    // Something that stopped moving: ask for its current record.
    for (const [id, item] of items) {
      if (!inFlight(item) || seen.has(id)) continue;
      const [fresh] = await browser.downloads.search({ id }).catch(() => []);
      if (fresh) note(fresh);
      else forget(id);
    }
    render();
  }

  /** Rolling transfer rate, smoothed so the number doesn't flicker. */
  function track(item) {
    const now = Date.now();
    const prev = rates.get(item.id);
    if (!prev) return rates.set(item.id, { at: now, bytes: item.bytesReceived, rate: 0 });
    const dt = (now - prev.at) / 1000;
    if (dt < 0.25) return;
    const sample = Math.max(0, (item.bytesReceived - prev.bytes) / dt);
    rates.set(item.id, { at: now, bytes: item.bytesReceived, rate: prev.rate ? prev.rate * 0.6 + sample * 0.4 : sample });
  }

  function pump() {
    const active = [...items.values()].some((item) => mine(item) && isMoving(item));
    if (active && !timer) timer = setInterval(poll, POLL_MS);
    else if (!active && timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  /* ---------- Actions ---------- */

  async function open(id) {
    if (!canOpen) canOpen = await browser.permissions.request({ permissions: ["downloads.open"] }).catch(() => false);
    if (canOpen) await browser.downloads.open(id).catch(() => browser.downloads.show(id));
    else browser.downloads.show(id);
  }

  function activate(item) {
    if (item.state === "complete") return open(item.id);
    if (isPaused(item)) return item.canResume ? browser.downloads.resume(item.id).catch(() => retry(item)) : retry(item);
    if (isFailed(item)) return retry(item);
    return browser.downloads.pause(item.id).catch(() => {});
  }

  async function retry(item) {
    dismissed.add(item.id);
    render();
    await browser.downloads.download({ url: item.url }).catch(() => {});
  }

  function rowMenu(item, x, y) {
    showMenu(
      [
        item.state === "complete" && { label: "Open", run: () => open(item.id) },
        item.state === "complete" && { label: "Show in Folder", run: () => browser.downloads.show(item.id) },
        inFlight(item) && { label: isPaused(item) ? "Resume" : "Pause", run: () => activate(item) },
        inFlight(item) && { label: "Cancel", run: () => browser.downloads.cancel(item.id).catch(() => {}) },
        isFailed(item) && { label: "Retry", run: () => retry(item) },
        "-",
        { label: "Copy Download Link", run: () => navigator.clipboard.writeText(item.url) },
        {
          label: "Remove from List",
          run: () => {
            dismissed.add(item.id);
            render();
          },
        },
      ].filter(Boolean),
      x,
      y
    );
  }

  /* ---------- Rendering ---------- */

  function makeRow(item) {
    const el = h(
      "li",
      { className: "dl", dataset: { id: String(item.id) } },
      h("span", { className: "dl-icon" }),
      h(
        "span",
        { className: "dl-text" },
        h("span", { className: "dl-name" }),
        h("span", { className: "dl-sub" }),
        h("span", { className: "dl-bar" }, h("span", { className: "dl-fill" }))
      ),
      h("button", { className: "icon-btn dl-act" }),
      h("button", { className: "icon-btn dl-x", title: "Remove from list" }, lucide(ICONS.x))
    );
    el.addEventListener("click", (e) => {
      const current = items.get(item.id);
      if (!current) return;
      if (e.target.closest(".dl-x")) {
        dismissed.add(item.id);
        return render();
      }
      activate(current);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const current = items.get(item.id);
      if (current) rowMenu(current, e.clientX, e.clientY);
    });
    return el;
  }

  function fillRow(el, item) {
    const [icon, text, act] = [el.querySelector(".dl-icon"), el.querySelector(".dl-text"), el.querySelector(".dl-act")];
    const [name, sub, bar] = [text.children[0], text.children[1], text.children[2]];
    const total = item.totalBytes > 0 ? item.totalBytes : 0;
    const got = item.bytesReceived || 0;
    const rate = rates.get(item.id)?.rate || 0;

    el.classList.toggle("active", isMoving(item));
    el.classList.toggle("paused", isPaused(item));
    el.classList.toggle("done", item.state === "complete");
    el.classList.toggle("failed", isFailed(item));

    const glyph = item.state === "complete" ? ICONS.check : isFailed(item) ? ICONS.alert : ICONS.download;
    if (icon.dataset.glyph !== glyph) {
      icon.dataset.glyph = glyph;
      icon.replaceChildren(lucide(glyph));
    }

    name.textContent = fileName(item);
    el.title = item.filename || item.url;

    if (item.state === "complete") sub.textContent = bytes(total || got);
    else if (isFailed(item))
      sub.textContent = item.error === "USER_CANCELED" ? "Canceled — click to retry" : "Failed — click to retry";
    else if (isPaused(item)) sub.textContent = `Paused · ${progressText(got, total)}`;
    else {
      const left = total && rate ? duration((total - got) / rate) : "";
      sub.textContent =
        progressText(got, total) + (rate ? ` · ${bytes(rate)}/s` : "") + (left ? ` · ${left}` : "");
    }

    const pct = total ? Math.min(100, (got / total) * 100) : 0;
    bar.hidden = !inFlight(item);
    bar.classList.toggle("unknown", isMoving(item) && !total);
    bar.firstChild.style.width = total ? `${pct}%` : "";

    const action =
      item.state === "complete"
        ? { glyph: ICONS.folder, title: "Show in folder" }
        : isFailed(item)
          ? { glyph: ICONS.retry, title: "Retry" }
          : isPaused(item)
            ? { glyph: ICONS.play, title: "Resume" }
            : { glyph: ICONS.pause, title: "Pause" };
    act.title = action.title;
    if (act.dataset.glyph !== action.glyph) {
      act.dataset.glyph = action.glyph;
      act.replaceChildren(lucide(action.glyph));
    }
    act.onclick = (e) => {
      e.stopPropagation();
      const current = items.get(item.id);
      if (!current) return;
      if (current.state === "complete") browser.downloads.show(current.id);
      else activate(current);
    };
  }

  function render() {
    expire();
    const list_ = visible();
    const nodes = list_.map((item) => {
      let el = rows.get(item.id);
      if (!el) rows.set(item.id, (el = makeRow(item)));
      fillRow(el, item);
      return el;
    });
    for (const id of [...rows.keys()]) if (!list_.some((item) => item.id === id)) rows.delete(id);
    syncChildren(list, nodes);
    const active = list_.filter(inFlight).length;
    head.children[1].textContent = active ? `${active} active` : "";
    clear.hidden = !list_.some((item) => !inFlight(item));
    ctx.el.hidden = nodes.length === 0;
    pump();
  }

  /* ---------- Wiring ---------- */

  browser.downloads.onCreated.addListener((item) => {
    dismissed.delete(item.id);
    note(item);
    render();
    if (isMoving(item)) poll();
  });

  browser.downloads.onChanged.addListener(async (delta) => {
    const [item] = await browser.downloads.search({ id: delta.id }).catch(() => []);
    if (item) {
      note(item);
      render();
    }
  });

  browser.downloads.onErased.addListener((id) => {
    forget(id);
    render();
  });

  return {
    /** Pick up downloads that were already running before the sidebar opened. */
    async start() {
      canOpen = await browser.permissions.contains({ permissions: ["downloads.open"] }).catch(() => false);
      // Paused downloads read as "interrupted", so they need their own query.
      const [running, paused] = await Promise.all([
        browser.downloads.search({ state: "in_progress" }).catch(() => []),
        browser.downloads.search({ paused: true }).catch(() => []),
      ]);
      for (const item of [...running, ...paused]) {
        track(item);
        note(item);
      }
      render();
    },
  };
}
