/* Paints the space tint before the page draws. The real color comes from
   storage (async), so without this every new tab flashes the default purple
   first. The sidebar and the command bar keep this cache fresh; it lives in
   the extension's own origin, shared by all of Arc's pages. */
(() => {
  try {
    const tint = localStorage.getItem("arc:space-tint");
    if (tint) document.documentElement.style.setProperty("--space", tint);
  } catch {
    // private window or blocked storage: the default color is fine
  }
})();
