"use strict";
browser.runtime.sendMessage({ type: "arcfox:newtab" }).catch(() => {});
