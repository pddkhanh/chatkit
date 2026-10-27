// chatkit — register the MCP servers with an agent: Claude Code, Codex, or
// print the configuration to paste by hand.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./paths.js";

const SERVER = path.join(ROOT, "lib", "mcp.js");
export const AGENTS = ["claude", "codex"];

const has = (cmd) => spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
const quiet = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

export function commandFor(platform) {
  return { command: process.execPath, args: [SERVER, platform] };
}

export function available() {
  return AGENTS.filter(has);
}

// What an agent already has under this name: null, "chatkit" (ours, safe to
// replace) or "other" (someone else's server: never touched).
function existing(agent, name) {
  const r = agent === "claude" ? quiet("claude", ["mcp", "get", name]) : quiet("codex", ["mcp", "get", name]);
  if (r.status !== 0) return null;
  return (r.stdout + r.stderr).includes(SERVER) ? "chatkit" : "other";
}

// Registers at user scope. Re-running replaces chatkit's own entry; a server
// of the same name that is not chatkit's stays, and chatkit takes
// "chatkit-<platform>" instead. Returns the name used.
export function register(agent, platform) {
  const { command, args } = commandFor(platform);
  if (!has(agent)) throw new Error(`${agent} is not installed (or not on PATH).`);
  let name = platform;
  if (existing(agent, name) === "other") name = `chatkit-${platform}`;
  if (existing(agent, name) === "other") throw new Error(`${agent} already has servers named ${platform} and ${name}; add chatkit by hand (chatkit mcp show).`);
  if (existing(agent, name) === "chatkit") quiet(agent, agent === "claude" ? ["mcp", "remove", "--scope", "user", name] : ["mcp", "remove", name]);
  const r =
    agent === "claude"
      ? quiet("claude", ["mcp", "add", "--scope", "user", name, "--", command, ...args])
      : quiet("codex", ["mcp", "add", name, "--", command, ...args]);
  if (r.status !== 0) throw new Error(`${agent} mcp add failed: ${(r.stderr || r.stdout).trim()}`);
  return name;
}

export function instructions(platforms) {
  const lines = [];
  const q = (s) => (/\s/.test(s) ? JSON.stringify(s) : s);
  lines.push("Claude Code (works in every folder):");
  for (const p of platforms) {
    const { command, args } = commandFor(p);
    lines.push(`  claude mcp add --scope user ${p} -- ${[command, ...args].map(q).join(" ")}`);
  }
  lines.push("", "Codex:");
  for (const p of platforms) {
    const { command, args } = commandFor(p);
    lines.push(`  codex mcp add ${p} -- ${[command, ...args].map(q).join(" ")}`);
  }
  lines.push("", "Or paste into ~/.codex/config.toml:");
  for (const p of platforms) {
    const { command, args } = commandFor(p);
    lines.push(`  [mcp_servers.${p}]`, `  command = ${JSON.stringify(command)}`, `  args = ${JSON.stringify(args)}`, "");
  }
  lines.push("Any other MCP client: a stdio server, command and args as above.");
  return lines.join("\n");
}
