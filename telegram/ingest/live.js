// chatkit — the live Telegram mirror (what `chatkit service start telegram`
// runs). It stores every new message on the account and never sends one.
//
// On start it catches up on whatever arrived while it was down. A health probe
// reconnects after a network drop and, if that keeps failing, exits so launchd
// restarts it cleanly; the restart catches up again.
import { NewMessage } from "teleproto/events/index.js";
import { connect } from "./client.js";
import { peerId, displayName, toRow } from "./map.js";
import { upsertChat, upsertSender, insertMessages, resolveQuotedSenders, counts } from "./db.js";
import { catchUpAll } from "./catchup.js";

const log = (...a) => console.log(new Date().toISOString(), ...a);

const PROBE_EVERY_MS = 60_000;
const UNHEALTHY_EXIT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms))]);

const client = await connect();
const me = await client.getMe();
const meId = peerId(me);
log(`mirror up as ${displayName(me)} (${meId})`);
log(`store: ${JSON.stringify(counts())}`);

client.addEventHandler(async (event) => {
  try {
    const msg = event.message;
    if (!msg?.id) return;
    const chat = await msg.getChat();
    const chatJid = peerId(chat);
    if (!chatJid) return;
    const sender = await msg.getSender().catch(() => null);
    if (sender) upsertSender(peerId(sender), displayName(sender), sender.username ?? null);
    const row = toRow(msg, chatJid, meId);
    upsertChat(chatJid, displayName(chat), row.timestamp);
    const added = insertMessages([row]);
    if (added && row.quoted_id) resolveQuotedSenders(chatJid);
    if (added) log(`+ ${displayName(chat) ?? chatJid}`);
  } catch (err) {
    log(`! handler: ${err?.message ?? err}`);
  }
}, new NewMessage({}));

const heal = (why) => catchUpAll(client, meId, log).catch((err) => log(`! catch-up (${why}): ${err?.message ?? err}`));
await heal("startup");

let unhealthySince = null;
setInterval(async () => {
  try {
    await withTimeout(client.getMe(), PROBE_TIMEOUT_MS, "health probe");
    if (unhealthySince) {
      log(`health: reconnected after ${Math.round((Date.now() - unhealthySince) / 1000)}s — catching up`);
      unhealthySince = null;
      heal("reconnect");
    }
  } catch (err) {
    unhealthySince ??= Date.now();
    const downMs = Date.now() - unhealthySince;
    log(`! health: ${err?.message ?? err} — down ${Math.round(downMs / 1000)}s`);
    try {
      await withTimeout(client.connect(), PROBE_TIMEOUT_MS, "reconnect");
    } catch (e) {
      log(`! health: reconnect failed: ${e?.message ?? e}`);
    }
    if (downMs >= UNHEALTHY_EXIT_MS) {
      log("health: still disconnected — exiting so launchd restarts the mirror");
      process.exit(1);
    }
  }
}, PROBE_EVERY_MS);

const shutdown = async (sig) => {
  log(`${sig} — disconnecting`);
  try {
    await client.disconnect();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  log(`! unhandled rejection: ${err?.message ?? err} — exiting for a clean restart`);
  process.exit(1);
});

log("listening for new messages");
