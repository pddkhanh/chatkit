// chatkit search engine — searchplatform.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import { personForSender } from "./people.js";
const PLATFORM = "whatsapp";
const WORDS_VARIANT = "wa1";
const TEEN_POLICY = "detect";
const daemonRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function configure({ messagesDbPath }) {
  if (!db.isConfigured() && messagesDbPath) db.configureDb(messagesDbPath);
}
const MENTION_RE = /@(\d{6,20})(?!\d)/g;
function mentionNames(num, chatJid = null) {
  const out = [];
  const person = personForSender(chatJid, num) ?? personForSender(null, num);
  if (person?.name) out.push(person.name);
  let contact = null;
  try {
    contact = db.displayName(num);
  } catch {
    contact = null;
  }
  if (contact && !out.some((n) => n.toLowerCase() === contact.toLowerCase())) out.push(contact);
  return out;
}
function docText(row) {
  const c = row.content ?? "";
  if (!c.includes("@")) return c;
  return c.replace(MENTION_RE, (m, num) => {
    const names = mentionNames(num, row.chat_jid);
    return names.length ? `${m} ${names.join(" ")}` : m;
  });
}
const DM_RE = /^(\d+)@(lid|s\.whatsapp\.net)$/;
function chatScope(jid) {
  const m = DM_RE.exec(String(jid ?? ""));
  if (!m) return [jid];
  let maps;
  try {
    maps = db.lidPnMaps();
  } catch {
    return [jid];
  }
  const other = m[2] === "lid" ? maps.lidToPn.get(m[1]) : maps.pnToLid.get(m[1]);
  if (!other) return [jid];
  return [jid, m[2] === "lid" ? `${other}@s.whatsapp.net` : `${other}@lid`];
}
function replyPrefixes() {
  try {
    const p = process.env.CHATKIT_CONFIG ?? path.join(daemonRoot, "config.json");
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    return [...new Set((cfg.bots ?? []).map((b) => b.replyPrefix).filter((x) => typeof x === "string" && x))];
  } catch {
    return [];
  }
}
const PREFIXES = replyPrefixes();
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;
function chatName(jid) {
  let name = null;
  try {
    name = db.getChat(jid)?.name ?? null;
  } catch {
    name = null;
  }
  const dm = DM_RE.exec(String(jid ?? ""));
  if (dm && (!name || /^\d+$/.test(name))) {
    const who = db.displayName(dm[1]);
    return who ? `DM with ${who}` : `DM ${dm[1]}`;
  }
  return name || jid;
}
const contactName = (sender) => sender ? db.displayName(String(sender)) : null;
function botNames() {
  try {
    const p = process.env.CHATKIT_CONFIG ?? path.join(daemonRoot, "config.json");
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const reg = Array.isArray(cfg.people?.["*"]) ? cfg.people["*"] : [];
    return (cfg.bots ?? []).filter((b) => typeof b.replyPrefix === "string" && b.replyPrefix).map((b) => {
      const person = reg.find((g) => String(g?.name ?? "").toLowerCase() === String(b.name).toLowerCase());
      const name = person?.name ?? String(b.name).replace(/^./, (c) => c.toUpperCase());
      return { prefix: b.replyPrefix, name };
    });
  } catch {
    return [];
  }
}
const BOT_NAMES = botNames();
function botName(row) {
  if (!row?.is_from_me || !row.content) return null;
  for (const b of BOT_NAMES) if (String(row.content).startsWith(b.prefix)) return b.name;
  return null;
}
function botRow(alias) {
  if (!PREFIXES.length) return null;
  const starts = PREFIXES.map((p) => `substr(${alias}.content, 1, ${[...p].length}) = ${sqlString(p)}`);
  return `(${alias}.is_from_me = 1 AND (${starts.join(" OR ")}))`;
}
export {
  PLATFORM,
  TEEN_POLICY,
  WORDS_VARIANT,
  botName,
  botRow,
  chatName,
  chatScope,
  configure,
  contactName,
  docText,
  mentionNames
};
