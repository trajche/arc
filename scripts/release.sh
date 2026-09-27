#!/usr/bin/env bash
# Cut a release: sign the current source, publish the .xpi as a GitHub release,
# and point updates.json at it so installed copies update themselves.
#
#   npm run release           patch release
#   npm run release -- minor  minor release
#
# Needs: .env with WEB_EXT_API_KEY / WEB_EXT_API_SECRET (addons.mozilla.org),
# the gh CLI signed in, and a clean git tree.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="trajche/arc"
ADDON_ID="arc@sidebar"

[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first." >&2; exit 1; }

# A half-finished release leaves the bump behind: pick it up instead of bumping
# again, so the number the last run uploaded is the one that gets released.

# sign.sh bumps the version (patch by default), then signs an unlisted build.
# It can fail after the upload has already landed — the connection drops, or the
# version goes to review and web-ext stops waiting. addons.mozilla.org then
# refuses that version number forever, so never re-run it: take the build from
# the API instead.
./sign.sh "${1:-patch}" || echo "Signing didn't return a file; checking addons.mozilla.org."
VERSION="$(node -p "require('./manifest.json').version")"
RELEASE_FILE="web-ext-artifacts/arc-$VERSION.xpi"
XPI="$(ls -t web-ext-artifacts/*"$VERSION"*.xpi 2>/dev/null | head -1 || true)"
if [ -n "$XPI" ]; then
  cp -f "$XPI" "$RELEASE_FILE"
else
  node scripts/amo.mjs fetch "$VERSION" "$RELEASE_FILE"
fi

TAG="v$VERSION"
INSTALL_NOTE="Install: download \`arc-$VERSION.xpi\` below and open it in Firefox. Installed copies update themselves."
# This version's section of CHANGELOG.md, if it has one, above the install line.
NOTES="$(awk -v v="## $VERSION" '$0 == v { on = 1; next } on && /^## / { exit } on' CHANGELOG.md)"
NOTES="$(printf '%s\n\n%s' "${NOTES:-}" "$INSTALL_NOTE")"
gh release create "$TAG" "$RELEASE_FILE" --repo "$REPO" --title "Arcsidebar $VERSION" --notes "$NOTES"

HASH="sha256:$(shasum -a 256 "$RELEASE_FILE" | cut -d' ' -f1)"
LINK="https://github.com/$REPO/releases/download/$TAG/arc-$VERSION.xpi"

node -e '
const fs = require("fs");
const [version, link, hash, id] = process.argv.slice(1);
const file = "updates.json";
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const updates = data.addons[id].updates.filter((u) => u.version !== version);
updates.push({ version, update_link: link, update_hash: hash });
updates.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
data.addons[id].updates = updates;
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
' "$VERSION" "$LINK" "$HASH" "$ADDON_ID"

git add manifest.json updates.json
git commit -q -m "Release $VERSION"
git push -q

echo "Released $TAG"
echo "  $LINK"
echo "Firefox checks updates.json daily; about:addons -> gear -> Check for Updates forces it."
