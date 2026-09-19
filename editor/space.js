/* global ArcFox */
/* Space editor, opened as a small popup window centered over the browser. */
import { h } from "../sidebar/dom.js";

const params = new URLSearchParams(location.search);
const windowId = Number(params.get("window")) || null;
const spaceId = params.get("space");

const EMOJIS = ["🏠", "💼", "🎨", "💻", "📚", "🎮", "🎵", "🛒", "✈️", "🧪", "📈", "🎬", "🍳", "🌱", "💡", "🚀", "⭐", "❤️", "🔥", "☕", "🐶", "⚽", "📷", "🧘"];

const $ = (id) => document.getElementById(id);
const form = $("form");
const nameInput = $("name");
const select = $("container");

let space = null;
let spaceCount = 0;
const draft = { name: "", icon: "", color: "blue" };

/** The editor takes the space's color (focus rings, Save button). */
function renderPreview() {
  document.documentElement.style.setProperty("--space", ArcFox.COLORS[draft.color]);
}

function renderEmojis() {
  // Keep a custom emoji (typed via the Other field) visible in the grid.
  const list = draft.icon && !EMOJIS.includes(draft.icon) ? [draft.icon, ...EMOJIS] : EMOJIS;
  const other = h(
    "button",
    {
      type: "button",
      className: `emoji more${$("picker").hidden ? "" : " selected"}`,
      title: "All emoji",
      onclick: () => togglePicker(),
    },
    "…"
  );
  $("emojis").replaceChildren(
    h("button", { type: "button", className: `emoji none${draft.icon ? "" : " selected"}`, title: "No icon", onclick: () => pickEmoji("") }, h("span", { className: "dot" })),
    ...list.map((e) =>
      h("button", { type: "button", className: `emoji${draft.icon === e ? " selected" : ""}`, onclick: () => pickEmoji(e) }, e)
    ),
    other
  );
}

function pickEmoji(e) {
  draft.icon = e;
  renderEmojis();
  renderPreview();
}

/* ---------- Full emoji picker (search by keyword) ---------- */

let emojiGroups = null; // [{g: group, e: [[emoji, "name keywords"]]}]

async function togglePicker(show = $("picker").hidden) {
  $("picker").hidden = !show;
  renderEmojis();
  if (show) {
    emojiGroups ??= await fetch(browser.runtime.getURL("editor/emoji.json")).then((r) => r.json());
    $("emoji-search").value = "";
    renderPicker("");
    $("emoji-search").focus();
  }
  fitWindow();
}

function renderPicker(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = ([, text]) => words.every((w) => text.includes(w));
  const sections = [];
  for (const group of emojiGroups) {
    const list = words.length ? group.e.filter(match) : group.e;
    if (!list.length) continue;
    sections.push(
      h("div", { className: "picker-group" }, group.g),
      h(
        "div",
        { className: "picker-row" },
        list.map(([e, text]) =>
          h(
            "button",
            {
              type: "button",
              className: `emoji${draft.icon === e ? " selected" : ""}`,
              title: text.split(" ").slice(0, 3).join(" "),
              onclick: () => {
                pickEmoji(e);
                togglePicker(false);
              },
            },
            e
          )
        )
      )
    );
  }
  $("picker-grid").replaceChildren(...(sections.length ? sections : [h("div", { className: "picker-empty" }, "No emoji found")]));
}

$("emoji-search").addEventListener("input", (e) => renderPicker(e.target.value));
$("emoji-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    togglePicker(false);
  } else if (e.key === "Enter") {
    // Enter picks the first match instead of submitting the form.
    e.preventDefault();
    $("picker-grid").querySelector(".picker-row .emoji")?.click();
  }
});

function renderColors() {
  $("colors").replaceChildren(
    ...Object.entries(ArcFox.COLORS).map(([name, hex]) =>
      h("button", {
        type: "button",
        className: `color${draft.color === name ? " selected" : ""}`,
        title: name,
        style: { "--c": hex },
        onclick: () => {
          draft.color = name;
          renderColors();
          renderPreview();
        },
      })
    )
  );
}

async function renderContainers() {
  let containers = null;
  try {
    containers = await browser.contextualIdentities.query({});
  } catch {
    // containers disabled
  }
  const hint = $("container-hint");
  if (!containers) {
    select.hidden = true;
    hint.textContent = "Turn on containers in Firefox settings to give a space its own logins.";
    return;
  }
  select.replaceChildren(
    h("option", { value: "" }, "No container"),
    ...containers.map((c) => h("option", { value: c.cookieStoreId }, c.name)),
    h("option", { value: "new" }, "＋ New container for this space")
  );
  // A deleted container matches no option, which leaves the select empty ("No container").
  select.value = space ? space.container || "" : "new";
  const updateHint = () => {
    const own = select.value === "new" || (space?.ownContainer && select.value === space.container);
    hint.textContent = select.value
      ? own
        ? "Separate cookies and logins, like an Arc profile. Its name and color follow this space."
        : "Tabs in this space open in this container (separate cookies and logins)."
      : "Tabs share cookies and logins with the rest of Firefox.";
  };
  select.addEventListener("change", updateHint);
  updateHint();
}

async function fitWindow() {
  await new Promise(requestAnimationFrame);
  const win = await browser.windows.getCurrent();
  const chrome = window.outerHeight - window.innerHeight;
  // Measure the form, not the page: the page is at least as tall as the window,
  // so it would never let the window shrink back (e.g. after closing the picker).
  const height = Math.ceil(form.getBoundingClientRect().bottom + chrome);
  if (Math.abs(win.height - height) > 2) await browser.windows.update(win.id, { height });
}

async function save(e) {
  e.preventDefault();
  const name = nameInput.value.trim() || "Space";
  let container = select.hidden ? space?.container || null : select.value || null;
  let ownContainer = !!space?.ownContainer && container === space?.container;
  try {
    if (container === "new") {
      const created = await browser.contextualIdentities.create({ name, color: draft.color, icon: "fingerprint" });
      container = created.cookieStoreId;
      ownContainer = true;
    } else if (ownContainer && container) {
      await browser.contextualIdentities.update(container, { name, color: draft.color });
    }
  } catch (err) {
    console.error("ArcFox: container update failed", err);
  }
  const saved = await ArcFox.saveSpace({
    ...(space ? { id: space.id } : {}),
    name,
    icon: draft.icon,
    color: draft.color,
    container,
    ownContainer,
  });
  if (!space && windowId) await ArcFox.switchSpace(windowId, saved.id);
  window.close();
}

let deleteArmed = false;
async function onDelete() {
  const btn = $("delete");
  if (!deleteArmed) {
    const n = (await ArcFox.spaceTabs(space.id)).length;
    deleteArmed = true;
    btn.classList.add("armed");
    btn.textContent = n ? `Click again: close ${n} tab${n === 1 ? "" : "s"}` : "Click again to delete";
    setTimeout(() => {
      deleteArmed = false;
      btn.classList.remove("armed");
      btn.textContent = "Delete Space";
    }, 4000);
    return;
  }
  await ArcFox.deleteSpace(space.id);
  window.close();
}

(async () => {
  const state = await ArcFox.getState();
  spaceCount = state.spaces.length;
  space = spaceId ? state.spaces.find((s) => s.id === spaceId) || null : null;
  if (space) Object.assign(draft, { name: space.name, icon: space.icon || "", color: space.color });
  else draft.color = Object.keys(ArcFox.COLORS)[state.spaces.length % 8];

  document.title = space ? "Edit Space" : "New Space";
  nameInput.value = draft.name;
  $("save").textContent = space ? "Save" : "Create Space";
  $("delete").hidden = !space || spaceCount < 2;

  renderPreview();
  renderEmojis();
  renderColors();
  await renderContainers();

  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
    renderPreview();
  });
  form.addEventListener("submit", save);
  $("cancel").addEventListener("click", () => window.close());
  $("delete").addEventListener("click", onDelete);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("picker").hidden) window.close();
  });

  nameInput.focus();
  nameInput.select();
  fitWindow();
})();
