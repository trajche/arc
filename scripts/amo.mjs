// Fetch a signed build from addons.mozilla.org.
//
//   node scripts/amo.mjs fetch <version> <out.xpi> [--wait-minutes 45]
//
// scripts/release.sh uses this when `web-ext sign` doesn't hand back a file:
// the upload usually succeeded (AMO refuses to take that version again), and
// the build is either already signed or still in review. Keys come from .env.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ADDON_ID = "arc@sidebar";
const API = "https://addons.mozilla.org/api/v5/addons/addon";

for (const line of fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n") : []) {
  const m = line.match(/^\s*(?:export\s+)?(WEB_EXT_API_KEY|WEB_EXT_API_SECRET)\s*=\s*"?([^"\n]+)"?\s*$/);
  if (m) process.env[m[1]] ??= m[2];
}
const { WEB_EXT_API_KEY: KEY, WEB_EXT_API_SECRET: SECRET } = process.env;
if (!KEY || !SECRET) {
  console.error("WEB_EXT_API_KEY / WEB_EXT_API_SECRET missing (set them in .env).");
  process.exit(2);
}

/** AMO wants a short-lived JWT per request. */
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: KEY, jti: String(Math.random()), iat: now, exp: now + 300 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const auth = () => ({ Authorization: `JWT ${jwt()}` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function versionRecord(version) {
  const r = await fetch(`${API}/${ADDON_ID}/versions/?filter=all_with_unlisted`, { headers: auth() });
  if (!r.ok) throw new Error(`versions: ${r.status} ${await r.text()}`);
  return (await r.json()).results?.find((v) => v.version === version) || null;
}

async function fetchSigned(version, out, waitMinutes) {
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const v = await versionRecord(version);
    if (!v) throw new Error(`Version ${version} isn't on addons.mozilla.org. Upload it first.`);
    // AMO serves the upload as .zip until it signs it, then as .xpi.
    if (v.file?.url?.endsWith(".xpi")) {
      const f = await fetch(v.file.url, { headers: auth() });
      if (!f.ok) throw new Error(`download: ${f.status}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(await f.arrayBuffer()));
      console.log(`Signed build downloaded: ${out}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Version ${version} is still "${v.file?.status}" after ${waitMinutes} minutes.\n` +
          "It's in review, which can take days. Nothing is lost: run this again later\n" +
          `  node scripts/amo.mjs fetch ${version} ${out}\n` +
          "and finish the release. Don't delete the version — its number can't be reused."
      );
    }
    process.stdout.write(`  ${version}: ${v.file?.status ?? "pending"}, waiting…\r`);
    await wait(30_000);
  }
}

/** Exit 0 if the version is on AMO (prints its file status), 3 if it isn't. */
async function status(version) {
  const v = await versionRecord(version);
  if (!v) {
    console.log(`${version}: not uploaded`);
    process.exit(3);
  }
  console.log(`${version}: ${v.file?.status}${v.file?.url?.endsWith(".xpi") ? " (signed)" : ""}`);
}

const [cmd, version, out, ...rest] = process.argv.slice(2);
const waitMinutes = Number(rest[rest.indexOf("--wait-minutes") + 1]) || 45;
const usage = "usage: node scripts/amo.mjs fetch <version> <out.xpi> [--wait-minutes 45]\n       node scripts/amo.mjs status <version>";
const run =
  cmd === "fetch" && version && out
    ? () => fetchSigned(version, out, waitMinutes)
    : cmd === "status" && version
      ? () => status(version)
      : null;
if (!run) {
  console.error(usage);
  process.exit(2);
}
await run().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
