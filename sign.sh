#!/bin/sh
# Bump the version, then sign an unlisted build with AMO.
# Keys come from .env (WEB_EXT_API_KEY / WEB_EXT_API_SECRET).
#
#   ./sign.sh          patch:  0.3.29 -> 0.3.30
#   ./sign.sh minor    minor:  0.3.29 -> 0.4.0
#   ./sign.sh major    major:  0.3.29 -> 1.0.0
set -e
cd "$(dirname "$0")"
[ -f .env ] && . ./.env
: "${WEB_EXT_API_KEY:?missing, set it in .env}"
: "${WEB_EXT_API_SECRET:?missing, set it in .env}"

node -e '
const fs = require("fs");
const kind = process.argv[1] || "patch";
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const v = m.version.split(".").map(Number);
if (kind === "major") m.version = [(v[0] || 0) + 1, 0, 0].join(".");
else if (kind === "minor") m.version = [v[0] || 0, (v[1] || 0) + 1, 0].join(".");
else m.version = [v[0] || 0, v[1] || 0, (v[2] || 0) + 1].join(".");
fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n");
console.log("version -> " + m.version);
' "${1:-patch}"
npx web-ext sign --channel=unlisted
