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

# sign.sh bumps the version (patch by default), then signs an unlisted build.
./sign.sh "${1:-patch}"
VERSION="$(node -p "require('./manifest.json').version")"
XPI="$(ls -t web-ext-artifacts/*.xpi | head -1)"
RELEASE_FILE="web-ext-artifacts/arc-$VERSION.xpi"
cp -f "$XPI" "$RELEASE_FILE"

TAG="v$VERSION"
gh release create "$TAG" "$RELEASE_FILE" --repo "$REPO" --title "Arc $VERSION" \
  --notes "Install: download \`arc-$VERSION.xpi\` below and open it in Firefox. Installed copies update themselves."

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
