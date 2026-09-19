/* global ArcFox */
/* Space switcher footer; opens the space editor window. */
import { h, showMenu, confirmDialog } from "./ui.js";

/** Open the space editor as a small window centered over the browser window. */
export async function openSpaceEditor(windowId, spaceId = null) {
  const base = browser.runtime.getURL("editor/space.html");
  // One editor at a time.
  for (const tab of await browser.tabs.query({})) {
    if (tab.url?.startsWith(base)) await browser.windows.remove(tab.windowId).catch(() => {});
  }
  const win = await browser.windows.get(windowId);
  const width = 420;
  const height = 560; // the editor resizes itself to fit
  const query = new URLSearchParams({ window: String(windowId), ...(spaceId ? { space: spaceId } : {}) });
  await browser.windows.create({
    url: `${base}?${query}`,
    type: "popup",
    width,
    height,
    left: Math.round(win.left + (win.width - width) / 2),
    top: Math.round(win.top + Math.max(40, (win.height - height) / 3)),
  });
}

async function deleteSpace(space) {
  const count = (await ArcFox.spaceTabs(space.id)).length;
  const ok = await confirmDialog(
    `Delete “${space.name}”?`,
    count ? `This closes ${count} tab${count === 1 ? "" : "s"} and removes its pinned items.` : "Its pinned items are removed.",
    "Delete Space"
  );
  if (ok) await ArcFox.deleteSpace(space.id);
}

/**
 * Footer with one button per space.
 * ctx: { el, windowId(), spaceId(), refresh(), onDrop(spaceId, dataTransfer) }
 */
export function createSpacesBar(ctx) {
  const list = ctx.el.querySelector(".space-list");
  const add = ctx.el.querySelector(".add-space");
  let spaces = [];

  async function switchTo(spaceId) {
    if (spaceId === ctx.spaceId()) return;
    await ArcFox.switchSpace(ctx.windowId(), spaceId);
    ctx.refresh();
  }

  // The editor switches to a newly created space itself.
  add.addEventListener("click", () => openSpaceEditor(ctx.windowId()));

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".space-btn");
    if (btn) switchTo(btn.dataset.space);
  });

  list.addEventListener("contextmenu", (e) => {
    const btn = e.target.closest(".space-btn");
    if (!btn) return;
    e.preventDefault();
    const space = spaces.find((s) => s.id === btn.dataset.space);
    const i = spaces.indexOf(space);
    showMenu(
      [
        { label: "Edit Space…", run: () => openSpaceEditor(ctx.windowId(), space.id) },
        { label: "Move Left", disabled: i === 0, run: () => ArcFox.moveSpace(space.id, spaces[i - 1]?.id) },
        { label: "Move Right", disabled: i === spaces.length - 1, run: () => ArcFox.moveSpace(space.id, spaces[i + 2]?.id || null) },
        "-",
        { label: "Delete Space…", danger: true, disabled: spaces.length < 2, run: () => deleteSpace(space) },
      ],
      e.clientX,
      e.clientY,
      ctx.refresh
    );
  });

  // Drop tabs / pinned items onto a space to move them there.
  list.addEventListener("dragover", (e) => {
    const btn = e.target.closest(".space-btn");
    if (!btn || !ctx.accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    for (const b of list.children) b.classList.toggle("drag-over", b === btn);
  });
  list.addEventListener("dragleave", (e) => {
    if (!list.contains(e.relatedTarget)) for (const b of list.children) b.classList.remove("drag-over");
  });
  list.addEventListener("drop", (e) => {
    const btn = e.target.closest(".space-btn");
    for (const b of list.children) b.classList.remove("drag-over");
    if (!btn) return;
    e.preventDefault();
    ctx.onDrop(btn.dataset.space, e.dataTransfer);
  });

  // Two-finger horizontal swipe switches spaces, like Arc.
  let swipe = 0;
  let cooldown = 0;
  document.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || spaces.length < 2) return;
      if (Date.now() < cooldown) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) < 90) return;
      const i = spaces.findIndex((s) => s.id === ctx.spaceId());
      const next = spaces[(i + Math.sign(swipe) + spaces.length) % spaces.length];
      swipe = 0;
      cooldown = Date.now() + 600;
      switchTo(next.id);
    },
    { passive: true }
  );

  return {
    render(state) {
      spaces = state.spaces;
      list.replaceChildren(
        ...spaces.map((s) =>
          h(
            "button",
            {
              className: `space-btn${s.id === state.spaceId ? " active" : ""}`,
              title: s.name,
              dataset: { space: s.id },
              style: { "--c": ArcFox.COLORS[s.color] || ArcFox.COLORS.blue },
            },
            s.icon ? h("span", { className: "space-emoji" }, s.icon) : h("span", { className: "space-dot" })
          )
        )
      );
    },
  };
}
