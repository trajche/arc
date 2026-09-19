#!/bin/sh
# Bump patch version, then sign an unlisted build with AMO.
# Keys come from .env (WEB_EXT_API_KEY / WEB_EXT_API_SECRET).
set -e
cd "$(dirname "$0")"
[ -f .env ] && . ./.env
: "${WEB_EXT_API_KEY:?missing, set it in .env}"
: "${WEB_EXT_API_SECRET:?missing, set it in .env}"

node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const v = m.version.split(".").map(Number);
v[2] = (v[2] || 0) + 1;
m.version = v.join(".");
fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n");
console.log("version -> " + m.version);
'
npx web-ext sign --channel=unlisted
