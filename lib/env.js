// chatkit — the local .env (mode 600). Holds the user's own keys; never printed.
import fs from "node:fs";
import { ENV_FILE } from "./paths.js";

export function loadEnv() {
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

export function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function setEnv(values) {
  const cur = { ...readEnv(), ...values };
  const body = Object.entries(cur)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${/\s|#/.test(v) ? JSON.stringify(v) : v}`)
    .join("\n");
  fs.writeFileSync(ENV_FILE, body + "\n", { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  for (const [k, v] of Object.entries(values)) if (v) process.env[k] = v;
}
