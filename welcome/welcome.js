"use strict";

const stage = document.querySelector(".stage");

// Hover or focus a feature: animate its part of the miniature sidebar.
for (const feature of document.querySelectorAll(".feature")) {
  const show = () => {
    // Re-trigger one-shot animations when moving between features.
    stage.dataset.demo = "";
    void stage.offsetWidth;
    stage.dataset.demo = feature.dataset.demo;
  };
  feature.addEventListener("mouseenter", show);
  feature.addEventListener("focus", show);
  feature.addEventListener("mouseleave", () => (stage.dataset.demo = ""));
  feature.addEventListener("blur", () => (stage.dataset.demo = ""));
}

// Shortcuts are written for macOS; show the Windows/Linux keys elsewhere.
if (!navigator.platform.startsWith("Mac")) {
  const keys = {
    "⌃1": "Alt+Shift+1",
    "⌃5": "Alt+Shift+5",
    "⌘T": "Ctrl+T",
    "⌥⇧L": "Alt+Shift+L",
    "⌥⇧S": "Alt+Shift+S",
    "⌘Q": "Ctrl+Q",
    "⌘L": "Ctrl+L",
  };
  for (const kbd of document.querySelectorAll("kbd")) kbd.textContent = keys[kbd.textContent] || kbd.textContent;
}

// Show the setup script for this system (Windows vs macOS/Linux).
const windows = navigator.platform.startsWith("Win");
for (const el of document.querySelectorAll(".script")) el.hidden = (el.dataset.os === "windows") !== windows;

// Copy the setup command, or the files shipped with Arc.
for (const button of document.querySelectorAll("button.copy-btn")) {
  const label = button.textContent;
  button.addEventListener("click", async () => {
    try {
      const text = button.dataset.copy
        ? document.getElementById(button.dataset.copy).textContent
        : await (await fetch(button.dataset.file)).text();
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      button.classList.add("done");
    } catch {
      button.textContent = "Copy failed, try again";
    }
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("done");
    }, 1800);
  });
}
