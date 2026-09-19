// Reload Arc in the running Firefox Developer Edition ("npm run dev"),
// over the local remote-debugging port. No restart, no reinstall.
import { connect } from "../node_modules/web-ext/lib/firefox/remote.js";

const PORT = Number(process.env.ARC_DEBUG_PORT || 6005);
const ADDON_ID = "arc@sidebar";

try {
  const firefox = await connect(PORT);
  await firefox.reloadAddon(ADDON_ID);
  firefox.disconnect();
  console.log("Arc reloaded");
} catch (err) {
  console.error(`Couldn't reload Arc: ${err.message}\nIs Firefox Developer Edition running via "npm run dev"?`);
  process.exit(1);
}
