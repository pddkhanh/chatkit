#!/usr/bin/env node
// chatkit — search your own WhatsApp and Telegram history from Claude Code or
// Codex. Everything runs on this Mac and is read-only: chatkit never sends a
// message. Run `chatkit setup` to start, `chatkit help` for every command.
import fs from "node:fs";
import { loadEnv, readEnv, setEnv } from "../lib/env.js";
import { PLATFORMS, configPath, stores } from "../lib/paths.js";
import * as service from "../lib/service.js";
import * as platforms from "../lib/platforms.js";
import * as agents from "../lib/agents.js";
import * as embed from "../lib/embed.js";
import { label, chatList } from "../lib/label.js";
import { ask, yes, secret, choose, step, release } from "../lib/ui.js";

loadEnv();
const NAMES = { whatsapp: "WhatsApp", telegram: "Telegram" };
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["--yes", "--dry-run"].includes(argv[i - 1])));

function platformArg(v, { all = true } = {}) {
  if (!v) {
    if (!all) throw new Error(`name a platform: ${PLATFORMS.join(" | ")}`);
    return PLATFORMS.filter((p) => platforms.isLinked(p) || fs.existsSync(stores(p).messages));
  }
  const p = { wa: "whatsapp", tg: "telegram" }[v] ?? v;
  if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${v}: ${PLATFORMS.join(" | ")}`);
  return [p];
}

function ensureConfig(p) {
  if (!fs.existsSync(configPath(p))) fs.writeFileSync(configPath(p), JSON.stringify({ people: {}, embeddings: { url: null } }, null, 2) + "\n");
}

async function telegramKeys({ force = false } = {}) {
  const env = readEnv();
  if (env.TG_API_ID && env.TG_API_HASH && !force) return;
  console.log(
    "\nTelegram needs an API id and hash of your own (free, two minutes):\n" +
      "  1. Open https://my.telegram.org and log in with your phone number.\n" +
      "  2. API development tools → create an app (any name, platform Desktop).\n" +
      "  3. Copy the api_id and api_hash here. They stay in this folder's .env.\n"
  );
  const id = await ask("api_id:");
  const hash = await secret("api_hash (hidden):");
  if (!/^\d+$/.test(id) || !/^[0-9a-f]{32}$/i.test(hash)) throw new Error("that does not look like an api_id (digits) and api_hash (32 hex characters).");
  setEnv({ TG_API_ID: id, TG_API_HASH: hash });
}

async function anthropicKey({ force = false } = {}) {
  if (process.env.ANTHROPIC_API_KEY && !force) return true;
  console.log("Labelling uses your own Anthropic API key (console.anthropic.com → API keys). It stays in this folder's .env.");
  const key = await secret("ANTHROPIC_API_KEY (hidden, blank to skip):");
  if (!key) return false;
  if (!key.startsWith("sk-ant-")) throw new Error("that does not look like an Anthropic API key (sk-ant-…).");
  setEnv({ ANTHROPIC_API_KEY: key });
  return true;
}

async function printChats(p, query = null) {
  const rows = await chatList(p, { query, limit: 30 });
  console.log(`\n  #  ${"messages".padStart(8)}  ${"convs".padStart(6)}  labelled  chat id${" ".repeat(18)}name`);
  rows.forEach((r, i) =>
    console.log(
      `${String(i + 1).padStart(3)}  ${String(r.messages).padStart(8)}  ${String(r.conversations).padStart(6)}  ${String(r.labelled).padStart(8)}  ${r.chat_jid.padEnd(25)}  ${r.name}`
    )
  );
  return rows;
}

async function labelFlow(p) {
  if (!(await anthropicKey())) return console.log("Skipped. Run `chatkit label` any time.");
  const rows = await printChats(p);
  const pick = await ask("\nWhich chats? Numbers from the list, comma-separated (blank to skip):");
  if (!pick) return;
  const chats = pick.split(",").map((s) => rows[Number(s.trim()) - 1]?.chat_jid).filter(Boolean);
  if (!chats.length) return console.log("No valid numbers; skipped.");
  await label({ platform: p, chats, confirm: (q) => yes(q) });
}

async function registerFlow(ps) {
  const found = agents.available();
  const opts = [
    ...found.map((a) => ({ label: a === "claude" ? "Claude Code" : "Codex", value: [a] })),
    ...(found.length > 1 ? [{ label: "Both", value: found }] : []),
    { label: "Show me the commands; I will do it myself", value: [] },
  ];
  const which = await choose("Which agent should get the search tools?", opts);
  if (!which.length) return console.log("\n" + agents.instructions(ps));
  for (const a of which)
    for (const p of ps) {
      const name = agents.register(a, p);
      console.log(`  ✓ ${a === "claude" ? "Claude Code" : "Codex"}: ${NAMES[p]} search tools added as "${name}"`);
    }
  console.log("\nStart a new session and ask, for example: \"what did Minh say about the trip in March?\"");
}

async function setup() {
  console.log("chatkit — search your own chats from Claude Code or Codex. Read-only; nothing ever sends.\n");
  step(1, "Platforms");
  const ps = await choose("Which platform?", [
    { label: "WhatsApp", value: ["whatsapp"] },
    { label: "Telegram", value: ["telegram"] },
    { label: "Both", value: ["whatsapp", "telegram"] },
  ]);
  const owner = await ask("Your name, as your own messages should be shown:", readEnv().CHATKIT_OWNER_NAME || "Me");
  setEnv({ CHATKIT_OWNER_NAME: owner });

  for (const p of ps) {
    ensureConfig(p);
    step(2, `${NAMES[p]}: link your account`);
    if (platforms.isLinked(p)) console.log("Already linked.");
    else {
      if (p === "telegram") await telegramKeys();
      if (p === "whatsapp") platforms.buildBridge();
      platforms.link(p);
    }
    step(3, `${NAMES[p]}: updates`);
    const live = await choose("How should new messages arrive?", [
      { label: "On demand — run `chatkit pull` when you want them", value: false },
      { label: "Live — a background service keeps it up to date", value: true },
    ]);
    if (live) {
      service.start(p);
      console.log(`Live service started (${service.label(p)}). It restarts at login.`);
    } else {
      service.stop(p, { quiet: true });
      if (p === "whatsapp")
        console.log("Pull at least every two or three weeks: WhatsApp logs out a linked device left unused for about a month.");
    }
    step(4, `${NAMES[p]}: search index`);
    const r = await platforms.index(p);
    console.log(`Indexed: ${r?.total ?? 0} messages. Free and local.`);
  }

  step(5, "Labels (optional, uses your Anthropic API key)");
  console.log(
    "Labels give each conversation an English topic, who it is about, people, keywords and facts.\n" +
      "They make search much better, mostly for chats in other languages. You pick the chats; a\n" +
      "price ceiling is shown before anything is sent. The text of those chats goes to Anthropic."
  );
  if (await yes("Label some chats now?")) for (const p of ps) await labelFlow(p);

  step(6, "Connect your agent");
  await registerFlow(ps);
  console.log("\nDone. `chatkit status` shows what is set up; `chatkit help` lists every command.");
}

async function status() {
  for (const p of PLATFORMS) {
    const s = stores(p);
    if (!platforms.isLinked(p) && !fs.existsSync(s.messages)) {
      console.log(`${NAMES[p]}: not set up`);
      continue;
    }
    const live = service.isRunning(p) ? "live service running" : service.isInstalled(p) ? "live service installed, NOT running" : "on demand";
    const size = fs.existsSync(s.messages) ? `${(fs.statSync(s.messages).size / 1e6).toFixed(0)} MB of messages` : "no messages yet";
    console.log(`${NAMES[p]}: ${platforms.isLinked(p) ? "linked" : "NOT linked"} · ${live} · ${size}`);
    if (service.isInstalled(p)) console.log(service.tail(p, 3).replace(/^/gm, "    "));
  }
  console.log(`Meaning search: ${service.isRunning("embed") ? "running" : "off"}`);
  const env = readEnv();
  const set = (v) => (v ? "set" : "not set");
  console.log(`Keys in .env: Telegram API id/hash ${set(env.TG_API_ID && env.TG_API_HASH)} · Anthropic API key ${set(env.ANTHROPIC_API_KEY)}`);
  console.log(`Your messages are shown as: ${env.CHATKIT_OWNER_NAME || "Me"}`);
}

const HELP = `chatkit — search your own WhatsApp and Telegram history from Claude Code or Codex.

  chatkit setup                         the guided setup (start here)
  chatkit status                        what is linked, running, and stored
  chatkit owner "<your name>"           how your own messages are shown (default: Me)
  chatkit key <anthropic|telegram>      enter an API key (hidden; saved to .env)
  chatkit link <wa|tg>                  link an account (WhatsApp: QR; Telegram: phone code)
  chatkit pull [wa|tg]                  fetch new messages now (on-demand mode)
  chatkit service start|stop <wa|tg>    live updates as a background service
  chatkit service logs <wa|tg>          the service's recent log lines
  chatkit index [wa|tg]                 update the search index (free; search does it too)
  chatkit chats <wa|tg> [name]          list chats: ids, size, how much is labelled
  chatkit label <wa|tg> --chat <id>[,<id>] [--dry-run] [--budget <usd>] [--yes]
                                        label past conversations with your Anthropic API key
  chatkit mcp add [claude|codex] [wa|tg]  give an agent the search tools
  chatkit mcp show                      print the MCP configuration to paste by hand
  chatkit embed setup                   optional: local meaning search (~640 MB model)

Your data stays in ./data; your keys in ./.env. Neither is ever committed or sent anywhere,
except the chats you choose to label, which go to Anthropic under your own key.`;

async function main() {
  const [cmd, sub, third] = positional;
  switch (cmd) {
    case undefined:
    case "help":
      return console.log(HELP);
    case "setup":
      return setup();
    case "status":
      return status();
    case "owner": {
      const name = positional.slice(1).join(" ").trim();
      if (!name) throw new Error('chatkit owner "<your name>"');
      setEnv({ CHATKIT_OWNER_NAME: name });
      return console.log(`Your own messages will be shown as ${name}.`);
    }
    case "key": {
      if (sub === "anthropic") return (await anthropicKey({ force: true })) && console.log("Saved to .env.");
      if (sub === "telegram") return (await telegramKeys({ force: true }), console.log("Saved to .env."));
      throw new Error("chatkit key anthropic | telegram");
    }
    case "link": {
      const [p] = platformArg(sub, { all: false });
      ensureConfig(p);
      if (p === "telegram") await telegramKeys();
      return platforms.link(p);
    }
    case "pull":
      for (const p of platformArg(sub)) {
        console.log(`${NAMES[p]}: pulling…`);
        platforms.pull(p);
        const r = await platforms.index(p);
        console.log(`${NAMES[p]}: ${r?.added ?? 0} new messages indexed.`);
      }
      return;
    case "service": {
      const [p] = platformArg(third, { all: false });
      if (sub === "start") {
        if (!platforms.isLinked(p)) throw new Error(`link ${p} first: chatkit link ${p}`);
        if (p === "whatsapp") platforms.buildBridge();
        service.start(p);
        return console.log(`${NAMES[p]} live service started.`);
      }
      if (sub === "stop") return console.log(service.stop(p) ? `${NAMES[p]} live service stopped.` : "It was not running.");
      if (sub === "logs") return console.log(service.tail(p, Number(flag("lines")) || 30));
      throw new Error("chatkit service start|stop|logs <wa|tg>");
    }
    case "index":
      for (const p of platformArg(sub)) {
        const r = await platforms.index(p);
        console.log(`${NAMES[p]}: ${r?.added ?? 0} new, ${r?.total ?? 0} messages indexed.`);
      }
      return;
    case "chats": {
      const [p] = platformArg(sub, { all: false });
      await printChats(p, third ?? null);
      return;
    }
    case "label": {
      const [p] = platformArg(sub, { all: false });
      const chats = String(flag("chat") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const budget = flag("budget") === null ? null : Number(flag("budget"));
      if (!has("dry-run") && !(await anthropicKey())) return;
      await label({ platform: p, chats, dryRun: has("dry-run"), budget, confirm: has("yes") ? async () => true : (q) => yes(q) });
      return;
    }
    case "mcp": {
      if (sub === "show") return console.log(agents.instructions(PLATFORMS.filter((p) => fs.existsSync(stores(p).messages))));
      if (sub !== "add") throw new Error("chatkit mcp add [claude|codex] [wa|tg]  ·  chatkit mcp show");
      const rest = positional.slice(2);
      const which = rest.filter((a) => agents.AGENTS.includes(a));
      const ps = rest.filter((a) => !agents.AGENTS.includes(a)).flatMap((a) => platformArg(a));
      const targets = ps.length ? ps : PLATFORMS.filter((p) => fs.existsSync(stores(p).messages));
      if (!targets.length) throw new Error("nothing to serve yet: run `chatkit setup` first.");
      if (!which.length) return registerFlow(targets);
      for (const a of which) for (const p of targets) console.log(`✓ ${a}: ${NAMES[p]} as "${agents.register(a, p)}"`);
      return;
    }
    case "embed": {
      if (sub !== "setup") throw new Error("chatkit embed setup");
      await embed.setup();
      for (const p of PLATFORMS.filter((x) => fs.existsSync(stores(x).messages))) {
        ensureConfig(p);
        embed.configure(p, true);
        console.log(`Embedding ${NAMES[p]} conversations (one time; a large account takes a while)…`);
        await embed.backfill(p);
      }
      return console.log("Meaning search is on.");
    }
    default:
      throw new Error(`unknown command ${cmd}. chatkit help lists them.`);
  }
}

main()
  .then(() => release())
  .catch((err) => {
  release();
  console.error(`\nchatkit: ${err?.message ?? err}`);
  process.exit(1);
});
