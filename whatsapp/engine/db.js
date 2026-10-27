// chatkit search engine — db.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
const daemonRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let db = null;
let dbPath = null;
let contactsDb = null;
let contactsDbPath = null;
function configureDb(configuredPath) {
  dbPath = path.resolve(daemonRoot, configuredPath);
  contactsDbPath = path.join(path.dirname(dbPath), "whatsapp.db");
}
const isConfigured = () => dbPath !== null;
function getDb() {
  if (db) return db;
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 3000");
  return db;
}
function getContactsDb() {
  if (contactsDb) return contactsDb;
  contactsDb = new Database(contactsDbPath, {
    readonly: true,
    fileMustExist: true
  });
  contactsDb.pragma("busy_timeout = 3000");
  return contactsDb;
}
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
let cache = { at: 0, names: /* @__PURE__ */ new Map(), lidToPn: /* @__PURE__ */ new Map(), pnToLid: /* @__PURE__ */ new Map() };
function contactCache() {
  if (Date.now() - cache.at < 5 * 60 * 1e3 && cache.names.size) return cache;
  const names = /* @__PURE__ */ new Map();
  const lidToPn = /* @__PURE__ */ new Map();
  const pnToLid = /* @__PURE__ */ new Map();
  try {
    const cdb = getContactsDb();
    try {
      for (const r of cdb.prepare("SELECT lid, pn FROM whatsmeow_lid_map").all()) {
        lidToPn.set(r.lid, r.pn);
        pnToLid.set(r.pn, r.lid);
      }
    } catch {
    }
    for (const r of cdb.prepare(
      `SELECT their_jid, first_name, full_name, push_name, business_name
         FROM whatsmeow_contacts`
    ).all()) {
      const user = r.their_jid.split("@")[0];
      const name = r.full_name || r.first_name || r.push_name || r.business_name;
      if (name) names.set(user, name);
    }
  } catch {
  }
  cache = { at: Date.now(), names, lidToPn, pnToLid };
  return cache;
}
function displayName(sender) {
  if (!sender) return null;
  const { names, lidToPn } = contactCache();
  const bare = sender.split("@")[0];
  const pn = lidToPn.get(bare) ?? bare;
  return names.get(pn) ?? null;
}
function lidPnMaps() {
  const { lidToPn, pnToLid } = contactCache();
  return { lidToPn, pnToLid };
}
function resolveSenderKeys(q) {
  const { names, lidToPn, pnToLid } = contactCache();
  const pns = /* @__PURE__ */ new Set();
  if (/^\+?\d{5,}$/.test(q.trim())) {
    pns.add(q.trim().replace("+", ""));
  } else {
    const needle = q.trim().toLowerCase();
    for (const [pn, name] of names) {
      if (name.toLowerCase().includes(needle)) pns.add(pn);
    }
  }
  const keys = /* @__PURE__ */ new Set();
  for (const pn of pns) {
    keys.add(pn);
    const lid = pnToLid.get(pn) ?? lidToPn.get(pn);
    if (lid) {
      keys.add(lid);
      keys.add(`${lid}@lid`);
    }
  }
  return [...keys].slice(0, 300);
}
function searchContacts(q, limit = 20) {
  const like = `%${escapeLike(q)}%`;
  return getContactsDb().prepare(
    `SELECT their_jid, first_name, full_name, push_name, business_name
       FROM whatsmeow_contacts
       WHERE their_jid LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\'
          OR full_name LIKE ? ESCAPE '\\' OR push_name LIKE ? ESCAPE '\\'
          OR business_name LIKE ? ESCAPE '\\'
       LIMIT ?`
  ).all(like, like, like, like, like, limit).map((r) => ({
    phone: r.their_jid.split("@")[0],
    name: r.full_name || r.first_name || r.push_name || r.business_name
  }));
}
function chatMembers(chatJid) {
  const rows = getDb().prepare(
    `SELECT sender, COUNT(*) AS n, MAX(timestamp) AS last
       FROM messages WHERE chat_jid = ? AND is_from_me = 0
       GROUP BY sender ORDER BY n DESC LIMIT 100`
  ).all(chatJid);
  return rows.map((r) => ({
    sender: r.sender,
    name: displayName(r.sender),
    messages: r.n,
    last: r.last
  }));
}
const MSG_COLS = "id, chat_jid, sender, content, timestamp, is_from_me, media_type, quoted_id";
function quotedPreviews(chatJid, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return /* @__PURE__ */ new Map();
  const rows = getDb().prepare(
    `SELECT id, sender, content, media_type, is_from_me FROM messages
       WHERE chat_jid = ? AND id IN (${want.map(() => "?").join(",")})`
  ).all(chatJid, ...want);
  return new Map(rows.map((r) => [r.id, r]));
}
function revisionsOf(chatJid, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return /* @__PURE__ */ new Map();
  const rows = getDb().prepare(
    `SELECT id, sender, deleted_at, deleted_by, edited_at, edited_content FROM messages
       WHERE chat_jid = ? AND id IN (${want.map(() => "?").join(",")})
         AND (deleted_at IS NOT NULL OR edited_at IS NOT NULL)`
  ).all(chatJid, ...want);
  return new Map(rows.map((r) => [r.id, r]));
}
function bound(value, edge) {
  if (!value) return null;
  const s = String(value).trim().replace("T", " ");
  if (/[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s} ${edge === "end" ? "23:59:59" : "00:00:00"}+08:00`;
  }
  return `${s}+08:00`;
}
function rangeWhere({ after, before }, col = "timestamp") {
  const where = [];
  const params = [];
  const lo = bound(after, "start");
  const hi = bound(before, "end");
  if (lo) {
    where.push(`${col} >= ?`);
    params.push(lo);
  }
  if (hi) {
    where.push(`${col} <= ?`);
    params.push(hi);
  }
  return { where, params };
}
function chatStats(chatJid) {
  return getDb().prepare(
    `SELECT COUNT(*) AS total, MIN(timestamp) AS oldest
       FROM messages WHERE chat_jid = ?`
  ).get(chatJid);
}
function recentMessages(chatJid, limit = 15, range = {}) {
  const { where, params } = rangeWhere(range);
  const clause = ["chat_jid = ?", ...where].join(" AND ");
  const matched = getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${clause}`).get(chatJid, ...params).n;
  const rows = getDb().prepare(
    `SELECT ${MSG_COLS} FROM messages WHERE ${clause}
       ORDER BY timestamp DESC LIMIT ?`
  ).all(chatJid, ...params, limit);
  return { rows: rows.reverse(), matched };
}
function searchMessages({
  query,
  chatJid = null,
  senders = null,
  after = null,
  before = null,
  limit = 20
}) {
  const where = [];
  const params = [];
  if (query) {
    where.push(`m.content LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(query)}%`);
  }
  if (chatJid) {
    where.push(`m.chat_jid = ?`);
    params.push(chatJid);
  }
  if (senders?.length) {
    where.push(`m.sender IN (${senders.map(() => "?").join(",")})`);
    params.push(...senders);
  }
  const range = rangeWhere({ after, before }, "m.timestamp");
  where.push(...range.where);
  params.push(...range.params);
  if (!where.length) return [];
  return getDb().prepare(
    `SELECT m.id, m.chat_jid, c.name AS chat_name, m.sender, m.content,
              m.timestamp, m.is_from_me, m.media_type, m.quoted_id
       FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
       WHERE ${where.join(" AND ")}
       ORDER BY m.timestamp DESC LIMIT ?`
  ).all(...params, limit);
}
function messageContext(chatJid, messageId, before = 5, after = 5) {
  const target = getDb().prepare(
    `SELECT ${MSG_COLS} FROM messages WHERE chat_jid = ? AND id = ?`
  ).get(chatJid, messageId);
  if (!target) return null;
  const beforeRows = getDb().prepare(
    `SELECT ${MSG_COLS} FROM messages
       WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`
  ).all(chatJid, target.timestamp, before).reverse();
  const afterRows = getDb().prepare(
    `SELECT ${MSG_COLS} FROM messages
       WHERE chat_jid = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?`
  ).all(chatJid, target.timestamp, after);
  return { before: beforeRows, target, after: afterRows };
}
function findMedia({
  kind = null,
  query = null,
  chatJid = null,
  senders = null,
  after = null,
  before = null,
  limit = 20
}) {
  const where = [];
  const params = [];
  if (kind === "link") {
    where.push(`(m.content LIKE '%http://%' OR m.content LIKE '%https://%')`);
  } else if (kind) {
    where.push(`m.media_type = ?`);
    params.push(kind);
  } else {
    where.push(
      `((m.media_type IS NOT NULL AND m.media_type != '')
        OR m.content LIKE '%http://%' OR m.content LIKE '%https://%')`
    );
  }
  if (query) {
    const like = `%${escapeLike(query)}%`;
    where.push(`(m.content LIKE ? ESCAPE '\\' OR m.filename LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  if (chatJid) {
    where.push(`m.chat_jid = ?`);
    params.push(chatJid);
  }
  if (senders?.length) {
    where.push(`m.sender IN (${senders.map(() => "?").join(",")})`);
    params.push(...senders);
  }
  const range = rangeWhere({ after, before }, "m.timestamp");
  where.push(...range.where);
  params.push(...range.params);
  return getDb().prepare(
    `SELECT m.id, m.chat_jid, c.name AS chat_name, m.sender, m.content,
              m.timestamp, m.is_from_me, m.media_type, m.filename, m.file_length
       FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
       WHERE ${where.join(" AND ")}
       ORDER BY m.timestamp DESC LIMIT ?`
  ).all(...params, limit);
}
const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]+/gi;
function normalizeHost(host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}
function urlsIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    try {
      out.push(new URL(raw));
    } catch {
    }
  }
  return out;
}
function linksPostedInChat(chatJid, host, limit = 500) {
  const want = normalizeHost(host);
  if (!want) return [];
  const rows = getDb().prepare(
    `SELECT content FROM messages
       WHERE chat_jid = ?
         AND content LIKE ? ESCAPE '\\'
         AND (content LIKE '%http://%' OR content LIKE '%https://%')
       ORDER BY timestamp DESC LIMIT ?`
  ).all(chatJid, `%${escapeLike(want)}%`, limit);
  const out = [];
  for (const r of rows) {
    for (const u of urlsIn(r.content)) {
      if (normalizeHost(u.hostname) === want) out.push(u);
    }
  }
  return out;
}
function sameUrl(a, b) {
  const p = (u) => u.pathname.replace(/\/+$/, "");
  return normalizeHost(a.hostname) === normalizeHost(b.hostname) && a.protocol === b.protocol && a.port === b.port && a.username === b.username && a.password === b.password && p(a) === p(b) && a.search === b.search;
}
function attachmentOf(chatJid, id) {
  if (!id) return null;
  return getDb().prepare(
    `SELECT media_type, filename, file_length FROM messages
         WHERE chat_jid = ? AND id = ?`
  ).get(chatJid, id) ?? null;
}
function messagesByIds(chatJid, ids) {
  const want = [...new Set((ids ?? []).filter(Boolean))].slice(0, 100);
  if (!want.length) return [];
  return getDb().prepare(
    `SELECT ${MSG_COLS} FROM messages
       WHERE chat_jid = ? AND id IN (${want.map(() => "?").join(",")})
       ORDER BY timestamp ASC`
  ).all(chatJid, ...want);
}
function getChat(jid) {
  return getDb().prepare(`SELECT jid, name, last_message_time FROM chats WHERE jid = ?`).get(jid);
}
function listChats(limit = 30) {
  return getDb().prepare(
    `SELECT jid, name, last_message_time FROM chats
       ORDER BY last_message_time DESC LIMIT ?`
  ).all(limit);
}
const noPollTables = (e) => /no such table/i.test(e?.message ?? "");
function recentPolls(chatJid, limit = 5) {
  try {
    return getDb().prepare(
      `SELECT id, creator, question, options, selectable_count, created_at
         FROM polls WHERE chat_jid = ? ORDER BY created_at DESC LIMIT ?`
    ).all(chatJid, limit).map((p) => ({ ...p, options: JSON.parse(p.options || "[]"), creatorName: displayName(p.creator) }));
  } catch (e) {
    if (noPollTables(e)) return [];
    throw e;
  }
}
function pollById(chatJid, pollId) {
  try {
    const p = getDb().prepare(
      `SELECT id, creator, question, options, selectable_count, created_at
         FROM polls WHERE chat_jid = ? AND id = ?`
    ).get(chatJid, pollId);
    return p ? { ...p, options: JSON.parse(p.options || "[]"), creatorName: displayName(p.creator) } : null;
  } catch (e) {
    if (noPollTables(e)) return null;
    throw e;
  }
}
function pollVotes(chatJid, pollId) {
  try {
    return getDb().prepare(
      `SELECT voter, options, updated_at FROM poll_votes
         WHERE chat_jid = ? AND poll_id = ? ORDER BY updated_at`
    ).all(chatJid, pollId).map((v) => ({ ...v, options: JSON.parse(v.options || "[]"), name: displayName(v.voter) }));
  } catch (e) {
    if (noPollTables(e)) return [];
    throw e;
  }
}
export {
  attachmentOf,
  chatMembers,
  chatStats,
  configureDb,
  displayName,
  findMedia,
  getChat,
  isConfigured,
  lidPnMaps,
  linksPostedInChat,
  listChats,
  messageContext,
  messagesByIds,
  normalizeHost,
  pollById,
  pollVotes,
  quotedPreviews,
  recentMessages,
  recentPolls,
  resolveSenderKeys,
  revisionsOf,
  sameUrl,
  searchContacts,
  searchMessages
};
