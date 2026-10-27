import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { makeClient, saveSession, apiId } from "./client.js";
import { displayName, peerId } from "./map.js";
import { existsSync } from "node:fs";
import { SESSION_PATH } from "./paths.js";
const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);
if (existsSync(SESSION_PATH)) {
  const yes = await ask(
    `A session already exists at ${SESSION_PATH}.
Logging in again replaces it. Continue? [y/N] `
  );
  if (yes.trim().toLowerCase() !== "y") {
    console.log("Aborted, nothing changed.");
    rl.close();
    process.exit(0);
  }
}
const client = makeClient("");
console.log(`Connecting with api_id ${apiId}…`);
await client.start({
  phoneNumber: async () => process.env.TG_PHONE || await ask("Phone number (with country code, e.g. +6512345678): "),
  phoneCode: async () => await ask("Code Telegram just sent you: "),
  password: async () => await ask("Two-step verification password (blank if none): "),
  onError: (err) => {
    console.error("login error:", err?.message ?? err);
    return true;
  }
});
const me = await client.getMe();
saveSession(client.session.save());
console.log(`
Logged in as ${displayName(me)} (id ${peerId(me)})`);
console.log(`Session written to ${SESSION_PATH} (mode 600).`);
await client.disconnect();
rl.close();
process.exit(0);
