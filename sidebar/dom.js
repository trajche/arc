/* DOM helpers with no page-specific dependencies (sidebar + editor). */

/** h("button", {className: "x", onclick}, "text", child) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style") for (const [k, v] of Object.entries(value)) el.style.setProperty(k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), v);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function letterFor(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // not a URL
  }
  let hash = 0;
  for (const c of host) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return h(
    "span",
    { className: "letter", style: { background: `hsl(${Math.abs(hash) % 360} 55% 52%)` } },
    (host[0] || "•").toUpperCase()
  );
}

/** Put a favicon (or a letter fallback) into `box`, skipping work when unchanged. */
export function setIcon(box, src, pageUrl) {
  const usable = src && /^(https?:|data:image\/|moz-extension:)/i.test(src) ? src : "";
  const key = usable || `letter:${pageUrl}`;
  if (box.dataset.src === key && box.firstChild) return;
  box.dataset.src = key;
  if (!usable) {
    box.replaceChildren(letterFor(pageUrl));
    return;
  }
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.onerror = () => box.replaceChildren(letterFor(pageUrl));
  img.src = usable;
  box.replaceChildren(img);
}

export function syncChildren(parent, nodes) {
  const same = parent.children.length === nodes.length && nodes.every((n, i) => parent.children[i] === n);
  if (!same) parent.replaceChildren(...nodes);
}
