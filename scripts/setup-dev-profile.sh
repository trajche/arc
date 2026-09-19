#!/usr/bin/env bash
# Create the "arc-dev" Firefox Developer Edition profile used for development:
#   - Arc loads unsigned, straight from this repo (extensions/arc@sidebar
#     is a proxy file containing the repo path)
#   - chrome/userChrome.css is a symlink to extras/userChrome.css
#   - user.js = extras/user.js + dev prefs (unsigned add-ons, local remote
#     debugging so `npm run reload` can reload Arc in place)
# Then: `npm run dev` to start it, `npm run reload` after code changes.
# macOS & Linux. Needs Firefox Developer Edition (or Nightly).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

case "$(uname -s)" in
  Darwin)
    FF="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
    ROOT="$HOME/Library/Application Support/Firefox/Profiles"
    ;;
  *)
    FF="$(command -v firefox-developer-edition || command -v firefox-dev || command -v firefox-nightly || true)"
    ROOT="$HOME/.mozilla/firefox"
    ;;
esac
[ -x "$FF" ] || { echo "Firefox Developer Edition not found (looked for: ${FF:-firefox-developer-edition})." >&2; exit 1; }

PROFILE="$ROOT/arc-dev"
if [ ! -f "$PROFILE/times.json" ]; then
  "$FF" -CreateProfile "arc-dev $PROFILE" >/dev/null 2>&1 || true
fi
mkdir -p "$PROFILE/chrome" "$PROFILE/extensions"

printf '%s\n' "$REPO" > "$PROFILE/extensions/arc@sidebar"
ln -sf "$REPO/extras/userChrome.css" "$PROFILE/chrome/userChrome.css"

{
  cat "$REPO/extras/user.js"
  cat <<'EOF'

// ---- Arc development profile ----
// Load Arc unsigned, straight from the repo (extensions/arc@sidebar).
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
// Local-only remote debugging, used by `npm run reload`.
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
// No first-run / default-browser noise.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("startup.homepage_welcome_url", "");
user_pref("browser.startup.homepage_override.mstone", "ignore");
EOF
} > "$PROFILE/user.js"

echo "Dev profile ready: $PROFILE"
echo "Start it with: npm run dev"
