// chatkit — linking an account and pulling new messages, per platform.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, ENV_FILE, stores, dataDir } from "./paths.js";
import * as service from "./service.js";
import { release } from "./ui.js";

const BRIDGE = path.join(ROOT, "whatsapp", "bridge", "whatsapp-bridge");

function run(cmd, args, opts = {}) {
  release(); // the child gets the terminal
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  return r.status;
}
const node = (script, args = [], opts = {}) =>
  run(process.execPath, ["--env-file-if-exists=" + ENV_FILE, path.join(ROOT, script), ...args], { cwd: ROOT, ...opts });

export const isLinked = (platform) => fs.existsSync(stores(platform).session);

// Two copies of one account's session talking to the server at once can get it
// logged out (WhatsApp) or its key revoked (Telegram). A pull never runs beside
// the service.
function refuseIfLive(platform) {
  if (service.isRunning(platform))
    throw new Error(`the live ${platform} service is running and already keeps it up to date. Stop it first (chatkit service stop ${platform}).`);
}

export function buildBridge({ force = false } = {}) {
  if (fs.existsSync(BRIDGE) && !force) return;
  const go = spawnSync("go", ["version"], { encoding: "utf8" });
  if (go.status !== 0) throw new Error("Go is not installed. Install it (brew install go), then try again.");
  console.log("Building the WhatsApp bridge (first time takes a minute)…");
  if (run("go", ["build", "-o", BRIDGE, "."], { cwd: path.dirname(BRIDGE), env: { ...process.env, CGO_ENABLED: "1" } }) !== 0)
    throw new Error("the bridge did not build. Xcode command line tools are needed: xcode-select --install");
}

function bridge(args) {
  buildBridge();
  const code = run(BRIDGE, args, { cwd: dataDir("whatsapp") });
  if (code === 3) throw new Error("WhatsApp logged this device out. Run `chatkit link whatsapp` to link again.");
  if (code !== 0 && code !== null) throw new Error(`the bridge stopped with exit code ${code}`);
}

export function link(platform) {
  refuseIfLive(platform);
  if (platform === "whatsapp") {
    console.log(
      "\nOn your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR code below.\n" +
        "WhatsApp sends about a year of history right after linking — and only then. Leave this running;\n" +
        "it stops by itself once the history has stopped arriving (a few minutes for most people).\n"
    );
    bridge(["-until-idle", "3m", "-min-run", "3m"]);
    return;
  }
  if (node("telegram/ingest/login.js") !== 0) throw new Error("Telegram login did not finish.");
  console.log("\nPulling your Telegram history. A big account takes a while; it resumes if stopped.\n");
  pull("telegram");
}

export function pull(platform) {
  refuseIfLive(platform);
  if (!isLinked(platform)) throw new Error(`${platform} is not linked yet: chatkit link ${platform}`);
  if (platform === "whatsapp") return bridge(["-until-idle", "45s", "-min-run", "30s"]);
  // backfill walks each chat back to its start (and skips chats already done);
  // catchup fetches what arrived since the newest stored message.
  if (node("telegram/ingest/backfill.js") !== 0) throw new Error("the Telegram history pull failed");
  if (node("telegram/ingest/catchup.js") !== 0) throw new Error("the Telegram catch-up failed");
}

// Bring search.db up to date with the store. Free and local.
export async function index(platform) {
  const s = stores(platform);
  if (!fs.existsSync(s.messages)) return null;
  const db = await import(`../${platform}/engine/db.js`);
  const idx = await import(`../${platform}/engine/searchindex.js`);
  db.configureDb(s.messages);
  idx.configureSearch(s.messages, s.search);
  return idx.sync();
}
