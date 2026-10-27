// chatkit — where everything lives. All personal data stays under data/
// (git-ignored); CHATKIT_DATA moves it elsewhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA = process.env.CHATKIT_DATA ? path.resolve(process.env.CHATKIT_DATA) : path.join(ROOT, "data");
export const ENV_FILE = path.join(ROOT, ".env");
export const PLATFORMS = ["whatsapp", "telegram"];

export function dataDir(platform) {
  const d = path.join(DATA, platform);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// The two files every platform has: the mirror's message store and the search
// index built from it.
export function stores(platform) {
  const d = dataDir(platform);
  return platform === "whatsapp"
    ? { messages: path.join(d, "store", "messages.db"), session: path.join(d, "store", "whatsapp.db"), search: path.join(d, "search.db") }
    : { messages: path.join(d, "messages.db"), session: path.join(d, "session"), search: path.join(d, "search.db") };
}

// <platform>/config.json: the engine's settings (people aliases, embeddings).
export const configPath = (platform) => path.join(ROOT, platform, "config.json");
