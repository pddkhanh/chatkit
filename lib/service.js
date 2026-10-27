// chatkit — live updates as macOS LaunchAgents: one per platform, started at
// login and restarted if it stops. Each runs a mirror that only receives.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, dataDir } from "./paths.js";

export const label = (name) => `dev.chatkit.${name}`;
const plistPath = (name) => path.join(os.homedir(), "Library", "LaunchAgents", `${label(name)}.plist`);
const domain = () => `gui/${process.getuid()}`;
export const logPath = (name) => path.join(dataDir("logs"), `${name}.log`);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(name, { args, cwd }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(name)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(logPath(name))}</string>
  <key>StandardErrorPath</key><string>${esc(logPath(name))}</string>
</dict>
</plist>
`;
}

// What each service runs. WhatsApp: the bridge in its data folder (it keeps
// store/ relative to where it runs). Telegram: the live mirror.
export function program(name) {
  if (name === "whatsapp")
    return { args: [path.join(ROOT, "whatsapp", "bridge", "whatsapp-bridge")], cwd: dataDir("whatsapp") };
  if (name === "telegram")
    return { args: [process.execPath, "--env-file-if-exists=" + path.join(ROOT, ".env"), path.join(ROOT, "telegram", "ingest", "live.js")], cwd: ROOT };
  if (name === "embed") return null; // written by embed.js, which knows the model path
  throw new Error(`unknown service ${name}`);
}

export function isRunning(name) {
  const r = spawnSync("launchctl", ["print", `${domain()}/${label(name)}`], { encoding: "utf8" });
  if (r.status !== 0) return false;
  return /state = running/.test(r.stdout);
}

export const isInstalled = (name) => fs.existsSync(plistPath(name));

export function start(name, prog = program(name)) {
  fs.mkdirSync(path.dirname(plistPath(name)), { recursive: true });
  stop(name, { quiet: true });
  fs.writeFileSync(plistPath(name), plist(name, prog));
  execFileSync("launchctl", ["bootstrap", domain(), plistPath(name)]);
}

export function stop(name, { quiet = false } = {}) {
  if (!isInstalled(name)) return false;
  spawnSync("launchctl", ["bootout", `${domain()}/${label(name)}`], { stdio: quiet ? "ignore" : "inherit" });
  fs.rmSync(plistPath(name), { force: true });
  return true;
}

export function tail(name, lines = 20) {
  try {
    const all = fs.readFileSync(logPath(name), "utf8").trimEnd().split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}
