import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./paths.js";
let db = null;
function open() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid               TEXT PRIMARY KEY,
      name              TEXT,
      last_message_time TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT,
      chat_jid      TEXT,
      sender        TEXT,
      content       TEXT,
      timestamp     TIMESTAMP,
      is_from_me    BOOLEAN,
      media_type    TEXT,
      filename      TEXT,
      url           TEXT,
      file_length   INTEGER,
      quoted_id     TEXT,
      quoted_sender TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );

    CREATE INDEX IF NOT EXISTS messages_ts       ON messages (timestamp);
    CREATE INDEX IF NOT EXISTS messages_chat_ts  ON messages (chat_jid, timestamp);

    -- Telegram user ids are stable integers, so name resolution is a plain
    -- lookup table. None of WhatsApp's @lid mapping or five-minute contact
    -- cache is needed here.
    CREATE TABLE IF NOT EXISTS senders (
      id       TEXT PRIMARY KEY,
      name     TEXT,
      username TEXT
    );

    -- Resume state for the backfill, one row per dialog. oldest_id is the
    -- lowest message id already stored; paging continues below it.
    CREATE TABLE IF NOT EXISTS backfill (
      chat_jid   TEXT PRIMARY KEY,
      oldest_id  INTEGER,
      n_messages INTEGER NOT NULL DEFAULT 0,
      done       INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
}
const stmt = (sql) => {
  const d = open();
  const key = sql;
  stmt.cache ??= /* @__PURE__ */ new Map();
  if (!stmt.cache.has(key)) stmt.cache.set(key, d.prepare(sql));
  return stmt.cache.get(key);
};
const upsertChat = (jid, name, lastTime) => stmt(
  `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE(excluded.name, chats.name),
       last_message_time = MAX(COALESCE(excluded.last_message_time, ''),
                               COALESCE(chats.last_message_time, ''))`
).run(jid, name ?? null, lastTime ?? null);
const upsertSender = (id, name, username) => stmt(
  `INSERT INTO senders (id, name, username) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(excluded.name, senders.name),
       username = COALESCE(excluded.username, senders.username)`
).run(id, name ?? null, username ?? null);
const insertMessage = () => stmt(
  `INSERT OR IGNORE INTO messages
       (id, chat_jid, sender, content, timestamp, is_from_me, media_type,
        filename, url, file_length, quoted_id, quoted_sender)
     VALUES
       (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me, @media_type,
        @filename, @url, @file_length, @quoted_id, @quoted_sender)`
);
function insertMessages(rows) {
  if (!rows.length) return 0;
  const ins = insertMessage();
  let n = 0;
  open().transaction(() => {
    for (const r of rows) n += ins.run(r).changes;
  })();
  return n;
}
const getCheckpoint = (jid) => stmt(`SELECT * FROM backfill WHERE chat_jid = ?`).get(jid) ?? null;
const setCheckpoint = (jid, { oldest_id, n_messages, done }) => stmt(
  `INSERT INTO backfill (chat_jid, oldest_id, n_messages, done, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(chat_jid) DO UPDATE SET
       oldest_id  = MIN(COALESCE(excluded.oldest_id, backfill.oldest_id),
                        COALESCE(backfill.oldest_id, excluded.oldest_id)),
       n_messages = backfill.n_messages + excluded.n_messages,
       done       = MAX(backfill.done, excluded.done),
       updated_at = excluded.updated_at`
).run(jid, oldest_id ?? null, n_messages ?? 0, done ? 1 : 0);
const resolveQuotedSenders = (jid = null) => stmt(
  `UPDATE messages AS m
        SET quoted_sender = (SELECT q.sender FROM messages q
                              WHERE q.chat_jid = m.chat_jid AND q.id = m.quoted_id)
      WHERE m.quoted_id IS NOT NULL
        AND m.quoted_sender IS NULL
        AND (@jid IS NULL OR m.chat_jid = @jid)`
).run({ jid });
const counts = () => ({
  chats: stmt(`SELECT COUNT(*) c FROM chats`).get().c,
  messages: stmt(`SELECT COUNT(*) c FROM messages`).get().c,
  senders: stmt(`SELECT COUNT(*) c FROM senders`).get().c
});
const newestStoredId = (jid) => {
  const row = stmt(
    `SELECT MAX(CAST(id AS INTEGER)) AS newest FROM messages WHERE chat_jid = ?`
  ).get(jid);
  return row?.newest ?? null;
};
const hasSentTo = (jid) => Boolean(stmt(`SELECT 1 FROM messages WHERE chat_jid = ? AND is_from_me = 1 LIMIT 1`).get(jid));
const close = () => {
  if (db) db.close();
  db = null;
  stmt.cache?.clear();
};
export {
  close,
  counts,
  getCheckpoint,
  hasSentTo,
  insertMessages,
  newestStoredId,
  open,
  resolveQuotedSenders,
  setCheckpoint,
  upsertChat,
  upsertSender
};
