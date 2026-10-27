import { pathToFileURL } from "node:url";
import { peerId, displayName, toRow } from "./map.js";
import {
  upsertChat,
  upsertSender,
  insertMessages,
  newestStoredId,
  resolveQuotedSenders,
  close
} from "./db.js";
const PAGE = 200;
const DEFAULT_MAX = 5e4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function catchUpChat(client, { entity, jid, name }, meId, log, max = DEFAULT_MAX) {
  const floor = newestStoredId(jid);
  if (floor === null) return { added: 0, walked: 0, capped: false, skipped: "never backfilled" };
  let offsetId = 0;
  let added = 0;
  let walked = 0;
  let reached = false;
  let newestTs = null;
  while (walked < max && !reached) {
    let page;
    try {
      page = await client.getMessages(entity, { limit: PAGE, offsetId });
    } catch (err) {
      const wait = err?.seconds;
      if (wait) {
        log(`  FLOOD_WAIT ${wait}s — sleeping`);
        await sleep((wait + 1) * 1e3);
        continue;
      }
      log(`  ! ${name ?? jid}: ${err?.message ?? err}`);
      break;
    }
    if (!page.length) break;
    const rows = [];
    for (const msg of page) {
      if (!msg?.id || msg.className === "MessageEmpty") continue;
      if (msg.id <= floor) {
        reached = true;
        continue;
      }
      const row = toRow(msg, jid, meId);
      newestTs ??= row.timestamp;
      rows.push(row);
      const s = msg.sender;
      if (s) upsertSender(peerId(s), displayName(s), s.username ?? null);
    }
    added += insertMessages(rows);
    walked += page.length;
    offsetId = page[page.length - 1].id;
    if (offsetId <= floor) reached = true;
  }
  if (added) {
    upsertChat(jid, name ?? null, newestTs);
    resolveQuotedSenders(jid);
  }
  return { added, walked, capped: !reached && walked >= max, floor };
}
async function findGaps(client, only = null) {
  const dialogs = await client.getDialogs({});
  const gaps = [];
  for (const d of dialogs) {
    const jid = peerId(d.entity);
    if (!jid) continue;
    if (only && jid !== String(only)) continue;
    const floor = newestStoredId(jid);
    if (floor === null) continue;
    const top = d.message?.id ?? null;
    if (top === null || top <= floor) continue;
    gaps.push({ entity: d.entity, jid, name: displayName(d.entity), floor, top, behind: top - floor });
  }
  return gaps.sort((a, b) => b.behind - a.behind);
}
async function catchUpAll(client, meId, log, { only = null, max = DEFAULT_MAX, dryRun = false } = {}) {
  const gaps = await findGaps(client, only);
  if (!gaps.length) {
    log("catch-up: no gaps — the mirror is current");
    return { chats: 0, added: 0 };
  }
  log(`catch-up: ${gaps.length} chat(s) behind — ${gaps.map((g) => `${g.name ?? g.jid} +${g.behind}`).join(", ")}`);
  if (dryRun) return { chats: gaps.length, added: 0, dryRun: true };
  let total = 0;
  for (const g of gaps) {
    const r = await catchUpChat(client, g, meId, log, max);
    total += r.added;
    log(
      `catch-up: ${g.name ?? g.jid} — ${r.added} recovered (walked ${r.walked}, above id ${g.floor})` + (r.capped ? ` — CAPPED at ${max}, run again` : "")
    );
  }
  log(`catch-up: done, ${total} message(s) recovered across ${gaps.length} chat(s)`);
  return { chats: gaps.length, added: total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { connect } = await import("./client.js");
  const argv = process.argv.slice(2);
  const flag = (name, d = null) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? d : argv[i + 1] ?? true;
  };
  const log = (...a) => console.log((/* @__PURE__ */ new Date()).toISOString().slice(11, 19), ...a);
  const client = await connect();
  const me = await client.getMe();
  log(`connected as ${displayName(me)} (${peerId(me)})`);
  await catchUpAll(client, peerId(me), log, {
    only: flag("chat"),
    max: Number(flag("max", DEFAULT_MAX)) || DEFAULT_MAX,
    dryRun: argv.includes("--dry-run")
  });
  await client.disconnect();
  close();
  process.exit(0);
}
export {
  DEFAULT_MAX,
  catchUpAll,
  catchUpChat,
  findGaps
};
