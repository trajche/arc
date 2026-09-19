/* global ArcFox */
import { parseArc } from "./arc-parse.js";
import { h } from "../sidebar/dom.js";

const $ = (id) => document.getElementById(id);
const isMac = navigator.platform.startsWith("Mac");

let sidebarJson = null;
let localState = null;
let plan = null;
const choices = new Map(); // profile key -> {container: "own" | "none", name}

// Where Arc keeps its sidebar on this system.
const path = document.querySelector(".path");
path.textContent = isMac ? path.dataset.mac : path.dataset.win;
for (const el of document.querySelectorAll('[data-os="mac"]')) el.hidden = !isMac;
document.querySelector("[data-copy-path]").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(path.textContent);
  e.target.textContent = "Copied";
  setTimeout(() => (e.target.textContent = "Copy path"), 1500);
});

async function readJson(input, nameEl) {
  const file = input.files[0];
  if (!file) return null;
  nameEl.textContent = file.name;
  return JSON.parse(await file.text());
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

$("sidebar-file").addEventListener("change", async (e) => {
  try {
    sidebarJson = await readJson(e.target, $("sidebar-name"));
    showError("");
    build();
  } catch (err) {
    sidebarJson = null;
    showError(`Couldn’t read that file: ${err.message}`);
  }
});

$("state-file").addEventListener("change", async (e) => {
  try {
    localState = await readJson(e.target, $("state-name"));
    showError("");
    build();
  } catch {
    localState = null;
    showError("That doesn’t look like Arc’s Local State file. You can skip it.");
  }
});

const countTabs = (pins) => pins.reduce((n, x) => n + (x.type === "tab" ? 1 : x.children.length), 0);
const countFolders = (pins) => pins.filter((x) => x.type === "folder").length;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function build() {
  if (!sidebarJson) return;
  try {
    plan = parseArc(sidebarJson, localState);
  } catch (err) {
    showError(err.message);
    $("preview").hidden = true;
    return;
  }
  for (const p of plan.profiles) {
    const prev = choices.get(p.key);
    // Arc's default profile shares Firefox's normal logins; the others get containers.
    choices.set(p.key, { container: prev?.container || (p.key === "Default" ? "none" : "own"), name: prev?.name || p.name });
  }

  $("profiles").replaceChildren(
    ...plan.profiles.map((p) => {
      const choice = choices.get(p.key);
      const name = h("input", {
        className: "name",
        value: choice.name,
        "aria-label": `Container name for ${p.name}`,
        oninput: (e) => (choice.name = e.target.value),
      });
      name.disabled = choice.container === "none";
      const select = h(
        "select",
        {
          "aria-label": `Container for ${p.name}`,
          onchange: (e) => {
            choice.container = e.target.value;
            name.disabled = choice.container === "none";
          },
        },
        h("option", { value: "own", selected: choice.container === "own" }, "Own container"),
        h("option", { value: "none", selected: choice.container === "none" }, "No container")
      );
      return h("div", { className: "profile" }, h("span", { className: "pname" }, p.name, h("small", {}, plural(p.spaces, "space"))), select, name);
    })
  );

  $("spaces").replaceChildren(
    ...plan.spaces.map((s, i) => {
      const tabs = countTabs(s.pins);
      const folders = countFolders(s.pins);
      const detail = [plural(tabs, "pinned tab"), folders ? plural(folders, "folder") : ""].filter(Boolean).join(", ");
      return h(
        "label",
        { className: "space", style: { "--c": ArcFox.COLORS[s.color] } },
        h("input", { type: "checkbox", checked: true, dataset: { index: i } }),
        h("span", { className: "icon" }, s.icon || h("span", { className: "dot" })),
        h("span", { className: "sname" }, s.name),
        h("span", { className: "detail" }, `${detail} · ${plan.profiles.find((p) => p.key === s.profile)?.name || s.profile}`)
      );
    })
  );

  $("favs-label").textContent = `Also import ${plural(plan.favorites.length, "favorite")}, kept per profile like in Arc`;
  $("favs").disabled = !plan.favorites.length;
  $("preview").hidden = false;
  $("status").textContent = "";
  $("import").disabled = false;
}

$("import").addEventListener("click", async () => {
  const picked = [...document.querySelectorAll("#spaces input:checked")].map((el) => plan.spaces[Number(el.dataset.index)]);
  if (!picked.length && !$("favs").checked) return;
  $("import").disabled = true;
  $("status").textContent = "Importing…";
  try {
    // One container per Arc profile that's used by an imported space.
    const containers = new Map();
    for (const s of picked) {
      const choice = choices.get(s.profile);
      if (choice.container !== "own" || containers.has(s.profile)) continue;
      const name = choice.name.trim() || s.profile;
      // Re-importing reuses the container made last time instead of adding another.
      const [existing] = await browser.contextualIdentities.query({ name });
      const identity = existing || (await browser.contextualIdentities.create({ name, color: s.color, icon: "fingerprint" }));
      containers.set(s.profile, identity.cookieStoreId);
    }
    // Favorites go to their Arc profile's container (skipped if none of that
    // profile's spaces were imported).
    const pickedProfiles = new Set(picked.map((s) => s.profile));
    const favorites = $("favs").checked
      ? plan.favorites.filter((f) => pickedProfiles.has(f.profile)).map((f) => ({ ...f, container: containers.get(f.profile) || null }))
      : [];
    const result = await ArcFox.importSpaces({
      spaces: picked.map((s) => ({ ...s, container: containers.get(s.profile) || null, ownContainer: containers.has(s.profile) })),
      favorites,
      replace: $("replace").checked,
    });
    $("status").textContent =
      `Imported ${plural(result.spaces, "space")}, ${plural(result.pins, "pinned tab")} and ${plural(result.favorites, "favorite")}` +
      (containers.size ? `, with ${plural(containers.size, "new container")}.` : ".");
    $("status").classList.add("done");
  } catch (err) {
    $("status").textContent = `Import failed: ${err.message}`;
    $("import").disabled = false;
  }
});
