import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { DATA, SESSION_PATH } from "./paths.js";
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH ?? "";
const RECONNECT = {
  connectionRetries: Number(process.env.TG_CONNECTION_RETRIES ?? 720),
  retryDelay: Number(process.env.TG_RETRY_DELAY_MS ?? 5e3)
};
function loadSession() {
  return existsSync(SESSION_PATH) ? readFileSync(SESSION_PATH, "utf8").trim() : "";
}
function saveSession(str) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(SESSION_PATH, str, { mode: 384 });
}
function makeClient(session = loadSession()) {
  if (!apiId || !apiHash) {
    throw new Error(
      "TG_API_ID / TG_API_HASH are not set. Run `chatkit setup` (or put them in .env)."
    );
  }
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    ...RECONNECT,
    // Sleep through rate limits rather than throwing. A full-account backfill
    // will hit FLOOD_WAIT; anything under an hour we simply wait out. Waits are
    // logged by the caller so a throttled run is distinguishable from a hung one.
    floodSleepThreshold: 60 * 60,
    autoReconnect: true
  });
}
async function connect() {
  const session = loadSession();
  if (!session) {
    throw new Error(
      "No session found. Run `chatkit link telegram` once from a terminal — Telegram sends a code to your phone."
    );
  }
  const client = makeClient(session);
  await client.connect();
  if (!await client.checkAuthorization()) {
    throw new Error(
      "Session exists but is not authorised (revoked from Telegram > Devices?). Run `chatkit link telegram` again."
    );
  }
  return client;
}
export {
  apiHash,
  apiId,
  connect,
  loadSession,
  makeClient,
  saveSession
};
