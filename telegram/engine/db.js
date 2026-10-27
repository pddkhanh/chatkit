// chatkit search engine — db.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
const daemonRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let db = null;
let dbPath = null;
function configureDb(configuredPath) {
  dbPath = path.resolve(daemonRoot, configuredPath);
}
function getDb() {
  if (db) return db;
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 3000");
  return db;
}
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
function displayName(sender) {
  if (!sender) return null;
  const r = getDb().prepare(`SELECT name, username FROM senders WHERE id = ?`).get(String(sender));
  if (!r) return null;
  return r.name ?? (r.username ? `@${r.username}` : null);
}
function resolveSenderKeys(q) {
  const needle = String(q ?? "").trim();
  if (!needle) return [];
  if (/^-?\d+$/.test(needle)) return [needle];
  const like = `%${escapeLike(needle)}%`;
  return getDb().prepare(
    `SELECT id FROM senders
        WHERE name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\'
        LIMIT 300`
  ).all(like, like).map((r) => r.id);
}
function searchContacts(q, limit = 20) {
  const like = `%${escapeLike(q)}%`;
  return getDb().prepare(
    `SELECT s.id, s.name, s.username, COUNT(m.id) AS messages
         FROM senders s LEFT JOIN messages m ON m.sender = s.id
        WHERE s.name LIKE ? ESCAPE '\\' OR s.username LIKE ? ESCAPE '\\' OR s.id = ?
        GROUP BY s.id ORDER BY messages DESC LIMIT ?`
  ).all(like, like, String(q).trim(), limit).map((r) => ({ id: r.id, name: r.name, username: r.username, messages: r.messages }));
}
function chatMembers(chatJid) {
  return getDb().prepare(
    `SELECT m.sender AS sender,
              COALESCE(s.name, '@' || s.username, m.sender) AS name,
              COUNT(*) AS messages, MAX(m.timestamp) AS last
         FROM messages m LEFT JOIN senders s ON s.id = m.sender
        WHERE m.chat_jid = ? AND m.is_from_me = 0
        GROUP BY m.sender ORDER BY messages DESC LIMIT 100`
  ).all(String(chatJid));
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
function linkMessages({
  chatJid = null,
  host = null,
  query = null,
  senders = null,
  after = null,
  before = null,
  limit = 200,
  scan = 8e3
} = {}) {
  const where = [`(m.content LIKE '%http://%' OR m.content LIKE '%https://%')`];
  const params = [];
  const want = host ? normalizeHost(host) : null;
  if (chatJid) {
    where.push(`m.chat_jid = ?`);
    params.push(String(chatJid));
  }
  if (want) {
    where.push(`m.content LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(want)}%`);
  }
  if (query) {
    where.push(`m.content LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(query)}%`);
  }
  if (senders?.length) {
    where.push(`m.sender IN (${senders.map(() => "?").join(",")})`);
    params.push(...senders);
  }
  const range = rangeWhere({ after, before }, "m.timestamp");
  where.push(...range.where);
  params.push(...range.params);
  const rows = getDb().prepare(
    `SELECT m.id, m.chat_jid, c.name AS chat_name, m.sender, m.content,
              m.timestamp, m.is_from_me
       FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
       WHERE ${where.join(" AND ")}
       ORDER BY m.timestamp DESC LIMIT ?`
  ).all(...params, scan);
  const out = [];
  let total = 0;
  for (const r of rows) {
    for (const u of urlsIn(r.content)) {
      if (want && normalizeHost(u.hostname) !== want) continue;
      total++;
      if (out.length < limit) out.push({ ...r, url: u, host: normalizeHost(u.hostname) });
    }
  }
  return { links: out, total };
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
export {
  attachmentOf,
  chatMembers,
  chatStats,
  configureDb,
  displayName,
  findMedia,
  getChat,
  linkMessages,
  linksPostedInChat,
  listChats,
  messageContext,
  messagesByIds,
  normalizeHost,
  quotedPreviews,
  recentMessages,
  resolveSenderKeys,
  sameUrl,
  searchContacts,
  searchMessages,
  urlsIn
};
