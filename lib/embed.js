// chatkit — optional meaning search. A small embedding model (Qwen3-Embedding
// 0.6B, ~640 MB) runs locally under llama.cpp; search then also finds
// conversations close in MEANING, across languages, marked ≈ in results.
// Nothing leaves the machine. Without it, search runs on words and labels.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DATA, configPath, stores } from "./paths.js";
import * as service from "./service.js";

export const PORT = 47800;
export const URL = `http://127.0.0.1:${PORT}`;
const ALIAS = "qwen3-embedding-0.6b-q8_0";
const FILE = "Qwen3-Embedding-0.6B-Q8_0.gguf";
const SOURCE = `https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/${FILE}`;
const SHA256 = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";
const modelPath = () => path.join(DATA, "models", FILE);

function llamaServer() {
  const r = spawnSync("which", ["llama-server"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest("hex");
}

// Point a platform's engine at the embedding server (or turn it off).
export function configure(platform, on) {
  const p = configPath(platform);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  cfg.people ??= {};
  cfg.embeddings = { url: on ? URL : null };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export async function setup(log = console.log) {
  let bin = llamaServer();
  if (!bin) {
    log("Installing llama.cpp with Homebrew…");
    if (spawnSync("brew", ["install", "llama.cpp"], { stdio: "inherit" }).status !== 0)
      throw new Error("brew install llama.cpp failed (is Homebrew installed?)");
    bin = llamaServer();
  }
  const file = modelPath();
  if (!fs.existsSync(file) || sha256(file) !== SHA256) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    log(`Downloading the embedding model (~640 MB) from ${SOURCE}`);
    if (spawnSync("curl", ["-fL", "--progress-bar", "-o", file, SOURCE], { stdio: "inherit" }).status !== 0)
      throw new Error("the model download failed");
    if (sha256(file) !== SHA256) {
      fs.rmSync(file, { force: true });
      throw new Error("the downloaded model does not match its checksum; deleted it. Try again.");
    }
  }
  service.start("embed", {
    cwd: DATA,
    args: [bin, "-m", file, "--alias", ALIAS, "--embedding", "--pooling", "last", "-c", "4096", "-np", "2", "--kv-unified",
      "-b", "2048", "-ub", "2048", "--cache-ram", "0", "-ngl", "99", "--host", "127.0.0.1", "--port", String(PORT), "--no-webui"],
  });
  log(`Embedding server running on ${URL} (LaunchAgent ${service.label("embed")}).`);
}

// Embed every conversation not embedded yet. Safe to stop and re-run.
export async function backfill(platform, log = console.log) {
  process.env.EMBED_URL = URL;
  const s = stores(platform);
  const db = await import(`../${platform}/engine/db.js`);
  const idx = await import(`../${platform}/engine/searchindex.js`);
  const E = await import(`../${platform}/engine/embed.js`);
  db.configureDb(s.messages);
  idx.configureSearch(s.messages, s.search);
  idx.sync();
  E.configureEmbeddings({ url: URL, log: () => {} });
  for (let i = 0; i < 60 && !(await E.health().catch(() => null))?.ok; i++) await new Promise((r) => setTimeout(r, 2000));
  let total = 0;
  for (;;) {
    const r = await E.embedPending({ limit: 256, settleMinutes: 0 });
    if (r.error) throw new Error(`embedding failed: ${r.error}`);
    const done = r.embedded + r.filler + r.unchanged;
    total += done;
    if (!r.picked) break;
    if (!done) throw new Error(`the embedding server failed on ${r.failed} conversations; is it running? (chatkit status)`);
    log(`  ${platform}: ${total} conversations embedded`);
  }
  return total;
}
