import { connect } from "./client.js";
import { peerId, displayName, toRow } from "./map.js";
import {
  upsertChat,
  upsertSender,
  insertMessages,
  getCheckpoint,
  setCheckpoint,
  resolveQuotedSenders,
  counts,
  close
} from "./db.js";
const argv = process.argv.slice(2);
const flag = (name, d = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? d : argv[i + 1] ?? true;
};
const has = (name) => argv.includes(`--${name}`);
const only = flag("chat");
const perChatLimit = Number(flag("limit", 0)) || Infinity;
const dryRun = has("dry-run");
const PAGE = 200;
const log = (...a) => console.log((/* @__PURE__ */ new Date()).toISOString().slice(11, 19), ...a);
const client = await connect();
const me = await client.getMe();
const meId = peerId(me);
log(`connected as ${displayName(me)} (${meId})`);
const dialogs = await client.getDialogs({});
const targets = dialogs.map((d) => ({ entity: d.entity, jid: peerId(d.entity), name: displayName(d.entity) })).filter((t) => t.jid && (!only || t.jid === String(only)));
if (only && !targets.length) {
  console.error(`No dialog with id ${only}. Run \`npm run chats\` to list them.`);
  await client.disconnect();
  process.exit(1);
}
log(`${targets.length} dialog(s) to walk${only ? "" : " — full account mirror"}`);
if (dryRun) {
  for (const t of targets) {
    const cp = getCheckpoint(t.jid);
    log(
      `${t.jid.padEnd(16)} ${cp?.done ? "done" : cp ? `resume < ${cp.oldest_id}` : "fresh"}  stored=${cp?.n_messages ?? 0}  ${t.name}`
    );
  }
  log("dry run — nothing fetched");
  await client.disconnect();
  close();
  process.exit(0);
}
let grandTotal = 0;
for (const t of targets) {
  const cp = getCheckpoint(t.jid);
  if (cp?.done && !has("force")) {
    log(`skip ${t.name} — already complete (${cp.n_messages} messages)`);
    continue;
  }
  upsertChat(t.jid, t.name, null);
  let offsetId = cp?.oldest_id ?? 0;
  let fetched = 0;
  let newest = null;
  let exhausted = false;
  log(`▶ ${t.name} (${t.jid})${offsetId ? ` — resuming below ${offsetId}` : ""}`);
  while (fetched < perChatLimit) {
    const want = Math.min(PAGE, perChatLimit - fetched);
    let page;
    try {
      page = await client.getMessages(t.entity, { limit: want, offsetId });
    } catch (err) {
      const wait = err?.seconds;
      if (wait) {
        log(`  FLOOD_WAIT ${wait}s — sleeping`);
        await new Promise((r) => setTimeout(r, (wait + 1) * 1e3));
        continue;
      }
      log(`  ! ${err?.message ?? err} — moving on to the next chat`);
      break;
    }
    if (!page.length) {
      exhausted = true;
      break;
    }
    const rows = [];
    for (const msg of page) {
      if (!msg?.id || msg.className === "MessageEmpty") continue;
      rows.push(toRow(msg, t.jid, meId));
      const s = msg.sender;
      if (s) upsertSender(peerId(s), displayName(s), s.username ?? null);
    }
    const added = insertMessages(rows);
    fetched += page.length;
    offsetId = page[page.length - 1].id;
    newest ??= page[0]?.date ? page[0].date : null;
    setCheckpoint(t.jid, { oldest_id: offsetId, n_messages: added, done: 0 });
    if (fetched % 2e3 < PAGE) log(`  … ${fetched} walked, oldest id ${offsetId}`);
  }
  setCheckpoint(t.jid, { oldest_id: offsetId, n_messages: 0, done: exhausted });
  resolveQuotedSenders(t.jid);
  const after = getCheckpoint(t.jid);
  grandTotal += fetched;
  log(
    `✓ ${t.name} — ${fetched} walked this run, ${after.n_messages} stored total${exhausted ? " (complete)" : " (more remains)"}`
  );
}
const c = counts();
log(`done. ${grandTotal} walked this run. store: ${c.messages} messages, ${c.chats} chats, ${c.senders} senders`);
await client.disconnect();
close();
process.exit(0);
