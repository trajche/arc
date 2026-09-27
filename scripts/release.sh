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
# It can fail after the upload has already landed — the connection drops, or the
# version goes to review and web-ext stops waiting. addons.mozilla.org then
# refuses that version number forever, so never upload it again: when this
# version is already there, finish that release instead of bumping past it.
VERSION="$(node -p "require('./manifest.json').version")"
# The tag lives on GitHub (gh release create makes it there), so ask GitHub
# rather than the local clone, which may never have fetched it.
if node scripts/amo.mjs status "$VERSION" >/dev/null 2>&1 &&
   ! gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  # Uploaded but never released: finish that one rather than burning its number.
  echo "Version $VERSION is already on addons.mozilla.org; finishing that release."
else
  ./sign.sh "${1:-patch}" || echo "Signing didn't return a file; checking addons.mozilla.org."
  VERSION="$(node -p "require('./manifest.json').version")"
fi
RELEASE_FILE="web-ext-artifacts/arc-$VERSION.xpi"
XPI="$(ls -t web-ext-artifacts/*"$VERSION"*.xpi 2>/dev/null | head -1 || true)"
if [ -n "$XPI" ]; then
  [ "$XPI" = "$RELEASE_FILE" ] || cp -f "$XPI" "$RELEASE_FILE"
else
  node scripts/amo.mjs fetch "$VERSION" "$RELEASE_FILE"
fi

# addons.mozilla.org hands back whatever was uploaded under this version, which
# may be an older build from an attempt that failed later. Publishing that ships
# stale code under a new number, so compare it against a fresh local build.
npx web-ext build --overwrite-dest >/dev/null
LOCAL_ZIP="$(ls -t web-ext-artifacts/*.zip | head -1)"
# Signing rewrites manifest.json without its trailing newline, so a hash that
# doesn't match is compared again with trailing whitespace ignored.
same_entry() {
  local entry="$1" a b
  a="$(unzip -p "$RELEASE_FILE" "$entry" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
  b="$(unzip -p "$LOCAL_ZIP" "$entry" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
  [ "$a" = "$b" ] && return 0
  a="$(printf '%s' "$(unzip -p "$RELEASE_FILE" "$entry" 2>/dev/null)" | shasum -a 256 | cut -d' ' -f1)"
  b="$(printf '%s' "$(unzip -p "$LOCAL_ZIP" "$entry" 2>/dev/null)" | shasum -a 256 | cut -d' ' -f1)"
  [ "$a" = "$b" ]
}

DIFFERENT=""
while IFS= read -r entry; do
  same_entry "$entry" || DIFFERENT="$DIFFERENT $entry"
done < <(unzip -Z1 "$LOCAL_ZIP" | grep -v '/$')
if [ -n "$DIFFERENT" ]; then
  echo "The signed build for $VERSION isn't this code. It differs in:" >&2
  for f in $DIFFERENT; do echo "  $f" >&2; done
  echo "That version was uploaded before these changes, and its number can't be reused." >&2
  echo "Bump to the next version and release that instead." >&2
  exit 1
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
