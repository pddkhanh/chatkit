// chatkit search engine — searchindex.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./trace.js";
import { exact, foldExact, fold, tokens, isUnspaced, WORD_RE, TEXTNORM_VERSION } from "./textnorm.js";
import { aboutMatcher, aboutKeys, resolvePerson } from "./people.js";
import { cleanFields, rowsKey, secretLike, FACTS_MAX, LABEL_VERSION } from "./labelfields.js";
import * as platform from "./searchplatform.js";
const WORDS_VERSION = `${TEXTNORM_VERSION}${platform.WORDS_VARIANT ? `:${platform.WORDS_VARIANT}` : ""}`;
const TEEN_POLICY = platform.TEEN_POLICY === "detect" ? "detect" : "all";
let idx = null;
let srcPath = null;
let idxPath = null;
const EPISODE_GAP_MINUTES = 20;
const EPISODE_MAX_MESSAGES = 40;
const EPISODE_TOKEN_BUDGET = 2500;
const EPISODE_NOTE_RESERVE = 120;
const EPISODE_BLOCK_BUDGET = 1e3;
const EPISODE_MAX_BLOCKS = 3;
const EPISODE_FULL_CANDIDATES = 5;
const EPISODE_LIST_MAX = 25;
const EPISODE_HEADER_MATCH_LIMIT = 40;
const SEARCH_HIT_POOL = 300;
const RRF_K = 60;
const WORD_WEIGHTS = [1, 0.25];
const LABEL_WEIGHTS = [1, 0.5];
const FIELDS_FUSE_WEIGHT = 0.5;
function fieldsFuseWeight() {
  const v = process.env.SEARCH_FIELDS_WEIGHT;
  return v !== void 0 && v !== "" && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : FIELDS_FUSE_WEIGHT;
}
const FACTS_SHOW = 5;
const FACT_SHOW_CHARS = 110;
const FACTS_LINE_CHARS = 420;
const WORD_TOKENIZE = `unicode61 remove_diacritics 0 categories 'L* N* Co M*'`;
const EPISODE_TRIM_LEVELS = [null, 3, 1, "top"];
const TOP_HITS = 3;
function configureSearch(messagesDbPath, searchDbPath) {
  srcPath = messagesDbPath;
  idxPath = searchDbPath;
  platform.configure?.({ messagesDbPath, searchDbPath });
}
function chatScope(chatJid) {
  if (!chatJid) return null;
  const s = platform.chatScope?.(chatJid);
  return Array.isArray(s) && s.length ? [.../* @__PURE__ */ new Set([chatJid, ...s])] : [chatJid];
}
const inChatScope = (chatJid, jid) => chatScope(chatJid).includes(jid);
function scopeSql(col, chatJid) {
  const s = chatScope(chatJid);
  if (!s) return null;
  return { sql: s.length === 1 ? `${col} = ?` : `${col} IN (${s.map(() => "?").join(", ")})`, params: s };
}
const docText = (row) => (platform.docText ? platform.docText(row) : row.content) ?? "";
const botRowSql = (alias) => platform.botRow?.(alias) ?? null;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function lowBound(v) {
  if (!v) return null;
  return String(v).trim().replace("T", " ");
}
function highBound(v) {
  if (!v) return null;
  const s = String(v).trim().replace("T", " ");
  return DAY_RE.test(s) ? `${s} 23:59:59~` : s;
}
function open() {
  if (idx) return idx;
  fs.mkdirSync(path.dirname(idxPath), { recursive: true });
  idx = new Database(idxPath);
  idx.pragma("journal_mode = WAL");
  idx.pragma("busy_timeout = 5000");
  idx.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL, chat_jid TEXT NOT NULL, sender TEXT,
      content TEXT, timestamp TEXT, is_from_me INTEGER, media_type TEXT,
      UNIQUE (id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS docs_chat_ts ON docs (chat_jid, timestamp);
    CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
      content, content='docs', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO msg_fts (rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      n_messages INTEGER NOT NULL DEFAULT 0,
      UNIQUE (chat_jid, started_at)
    );
  `);
  for (const ddl of [
    "ALTER TABLE docs ADD COLUMN quoted_id TEXT",
    "ALTER TABLE docs ADD COLUMN episode_id INTEGER",
    // Phase 2. `about` is its own column rather than part of a rendered header
    // string because Phase 3 makes it a search filter — "everything this group
    // said ABOUT someone" is a WHERE clause, not a substring hunt.
    "ALTER TABLE episodes ADD COLUMN topic TEXT",
    "ALTER TABLE episodes ADD COLUMN about TEXT",
    "ALTER TABLE episodes ADD COLUMN register TEXT",
    "ALTER TABLE episodes ADD COLUMN labeled_at TEXT",
    // What the episode looked like when it was labelled. Only diagnostics: an
    // episode that later grows keeps its old header, and this is how you find
    // those rather than guessing.
    "ALTER TABLE episodes ADD COLUMN labeled_n_messages INTEGER"
  ]) {
    try {
      idx.exec(ddl);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  idx.exec(`
    CREATE INDEX IF NOT EXISTS docs_episode ON docs (episode_id, timestamp);
    -- Partial, so the hot path in assignEpisodes ("is there anything left to
    -- segment?") reads an index that is empty whenever the answer is no.
    CREATE INDEX IF NOT EXISTS docs_unassigned ON docs (chat_jid)
      WHERE episode_id IS NULL;

    -- Headers get their own FTS table rather than joining msg_fts: msg_fts is
    -- external-content over docs, so its rowids ARE doc rowids and there is no
    -- room in it for a row that is not a message. This one is a plain FTS5
    -- table keyed on episodes.id, which makes it fully updatable — a re-label
    -- is DELETE + INSERT on the same rowid.
    CREATE VIRTUAL TABLE IF NOT EXISTS ep_fts USING fts5(
      header, tokenize='trigram'
    );
    -- segment() deletes episodes whose boundary moved. Without this the header
    -- index would keep answering for conversations that no longer exist.
    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      DELETE FROM ep_fts WHERE rowid = old.id;
    END;
    -- Partial again: the ongoing sweep asks "anything closed and unlabelled?"
    -- on a timer, and when the answer is no it should read an empty index.
    CREATE INDEX IF NOT EXISTS episodes_unlabeled ON episodes (ended_at)
      WHERE topic IS NULL;
    CREATE INDEX IF NOT EXISTS episodes_about ON episodes (about)
      WHERE about IS NOT NULL;
    -- One row per Batch-API submission made by scripts/bootstrap-episodes.js.
    -- This is what makes a 11k-call backfill resumable across a kill: the
    -- script looks here first and ingests anything still in flight before it
    -- submits more work.
    CREATE TABLE IF NOT EXISTS episode_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      n_requests INTEGER NOT NULL,
      stage TEXT,
      status TEXT NOT NULL,
      ingested_at TEXT
    );

    -- The word index (see the top of this file). Contentless: the text lives
    -- in docs / episodes already, and these hold only the postings, keyed on
    -- the same rowids. contentless_delete so a row can be replaced or removed.
    -- No INSERT trigger on docs: the normalizer is JS, and a trigger calling
    -- an app-defined function would break every other connection that writes
    -- docs. indexWords() keeps it current instead, off meta.words_mark.
    CREATE VIRTUAL TABLE IF NOT EXISTS msg_words USING fts5(
      exact, folded, content='', contentless_delete=1, tokenize="${WORD_TOKENIZE}"
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ep_words USING fts5(
      exact, folded, content='', contentless_delete=1, tokenize="porter ${WORD_TOKENIZE}"
    );
    CREATE TRIGGER IF NOT EXISTS episodes_ad_words AFTER DELETE ON episodes BEGIN
      DELETE FROM ep_words WHERE rowid = old.id;
    END;
    -- The label watermark's lookup (catchUpLabels): "anything labelled since
    -- ep_words was last brought up to date?" on every sync, so it must be an
    -- index probe, not a scan of every episode.
    CREATE INDEX IF NOT EXISTS episodes_labeled_at ON episodes (labeled_at)
      WHERE labeled_at IS NOT NULL;

    -- TEEN_POLICY "detect" only (WhatsApp): whether a chat's words go through
    -- the Vietnamese teen-code map, decided from its own messages the first
    -- time it is word-indexed (teenOf). Provisional (final = 0) while the
    -- chat is too small to tell; re-decided as it grows. Empty under "all".
    CREATE TABLE IF NOT EXISTS chat_norm (
      chat_jid TEXT PRIMARY KEY,
      teen INTEGER NOT NULL,
      docs INTEGER NOT NULL,
      vi INTEGER NOT NULL,
      final INTEGER NOT NULL,
      decided_at TEXT NOT NULL
    );

    -- Meaning search (embed.js): one row per embedded episode. model + recipe
    -- say what made the vector (rows of another model are never compared);
    -- n_messages + labeled_at are the episode as it was when embedded, so a
    -- conversation that grew or was re-labelled shows up as stale; hash is
    -- the text's. vec is int8[dims] with its scale, NULL for a filler-only
    -- conversation (recorded so it is not reconsidered until it changes) or
    -- one the server refused (tokens = -1). seq orders writes, which is how
    -- another process's vector cache notices new rows (COUNT + MAX(seq) on
    -- the covering index).
    CREATE TABLE IF NOT EXISTS ep_vecs (
      episode_id INTEGER PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      model TEXT NOT NULL,
      recipe INTEGER NOT NULL,
      hash TEXT NOT NULL,
      n_messages INTEGER NOT NULL,
      labeled_at TEXT,
      tokens INTEGER,
      scale REAL,
      vec BLOB,
      seq INTEGER NOT NULL,
      embedded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ep_vecs_scope ON ep_vecs (model, chat_jid, seq);
    CREATE INDEX IF NOT EXISTS ep_vecs_seq ON ep_vecs (seq);
    -- A conversation re-segmented away takes its vector with it — whichever
    -- code version deleted it, since the trigger lives in the database.
    CREATE TRIGGER IF NOT EXISTS episodes_ad_vecs AFTER DELETE ON episodes BEGIN
      DELETE FROM ep_vecs WHERE episode_id = old.id;
    END;

    -- Label fields (Phase 3): people / keywords / facts, one row per episode,
    -- JSON arrays (facts: [{text, msgs: [message ids]}]). A side table, not
    -- columns on episodes, so the save path cannot touch the paid label and
    -- older code never sees it. status "ok", "refused" (the model declined;
    -- recorded so the conversation is not paid for again on every run) or
    -- "skipped" (never sent: it looks like it holds a secret — model says why);
    -- model + version + written_at say what wrote it; n_messages is the
    -- episode's size then; dropped counts facts whose citations failed.
    CREATE TABLE IF NOT EXISTS ep_fields (
      episode_id INTEGER PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      people TEXT NOT NULL DEFAULT '[]',
      keywords TEXT NOT NULL DEFAULT '[]',
      facts TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      model TEXT,
      version INTEGER NOT NULL,
      n_messages INTEGER,
      dropped INTEGER NOT NULL DEFAULT 0,
      written_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ep_fields_chat ON ep_fields (chat_jid, status);
    -- Their word index: same columns and tokenizer as ep_words, rowid =
    -- episodes.id. A table of its own so ep_words' bm25 statistics (and so
    -- every topic ranking) do not move when fields arrive.
    CREATE VIRTUAL TABLE IF NOT EXISTS ep_fwords USING fts5(
      exact, folded, content='', contentless_delete=1, tokenize="porter ${WORD_TOKENIZE}"
    );
    CREATE TRIGGER IF NOT EXISTS episodes_ad_fields AFTER DELETE ON episodes BEGIN
      DELETE FROM ep_fields WHERE episode_id = old.id;
      DELETE FROM ep_fwords WHERE rowid = old.id;
    END;
  `);
  for (const ddl of ["ALTER TABLE ep_vecs ADD COLUMN fields_at TEXT"]) {
    try {
      idx.exec(ddl);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  return idx;
}
function indexDb() {
  return open();
}
const getMeta = (k) => open().prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v ?? null;
const setMeta = (k, v) => open().prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
const SYNC_LOOKBACK = "-14 hours";
function sync() {
  const db = open();
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  src.pragma("busy_timeout = 5000");
  try {
    const since = getMeta("watermark") ?? "";
    const lo = since ? src.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S', ?, ?)").pluck().get(since, SYNC_LOOKBACK) ?? since : "";
    const rows = src.prepare(
      `SELECT id, chat_jid, sender, content, timestamp, is_from_me, media_type, quoted_id
         FROM messages
         WHERE timestamp >= @lo
           AND (@since = '' OR julianday(timestamp) >= julianday(@since)
                OR ((julianday(timestamp) IS NULL OR julianday(@since) IS NULL) AND timestamp >= @since))
         ORDER BY julianday(timestamp), timestamp`
    ).all({ lo, since });
    if (!rows.length) {
      const w2 = catchUpWords();
      return { added: 0, assigned: assignEpisodes(), total: count(), words: w2.docs, labelWords: w2.labels };
    }
    const ins = db.prepare(
      `INSERT OR IGNORE INTO docs (id, chat_jid, sender, content, timestamp, is_from_me, media_type, quoted_id)
       VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me, @media_type, @quoted_id)`
    );
    let added = 0;
    db.transaction(() => {
      for (const r of rows) {
        added += ins.run({ ...r, content: r.content ?? "" }).changes;
      }
    })();
    setMeta("watermark", rows[rows.length - 1].timestamp);
    const w = catchUpWords();
    return { added, assigned: assignEpisodes(), total: count(), words: w.docs, labelWords: w.labels };
  } finally {
    src.close();
  }
}
function refreshDocs(chatJid) {
  const db = open();
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    const have = new Map(
      db.prepare("SELECT rowid, id, content, episode_id FROM docs WHERE chat_jid = ?").all(chatJid).map((d) => [d.id, d])
    );
    const mark = Number(getMeta("words_mark") ?? 0);
    const teen = teenOf(db, chatJid);
    const ftsDel = db.prepare("INSERT INTO msg_fts (msg_fts, rowid, content) VALUES ('delete', ?, ?)");
    const ftsAdd = db.prepare("INSERT INTO msg_fts (rowid, content) VALUES (?, ?)");
    const upd = db.prepare("UPDATE docs SET content = ? WHERE rowid = ?");
    const words = db.prepare("INSERT OR REPLACE INTO msg_words (rowid, exact, folded) VALUES (?, ?, ?)");
    const episodes = /* @__PURE__ */ new Set();
    let changed = 0;
    db.transaction(() => {
      for (const r of src.prepare("SELECT id, sender, content FROM messages WHERE chat_jid = ?").all(chatJid)) {
        const d = have.get(r.id);
        const content = r.content ?? "";
        if (!d || (d.content ?? "") === content) continue;
        ftsDel.run(d.rowid, d.content ?? "");
        upd.run(content, d.rowid);
        ftsAdd.run(d.rowid, content);
        if (d.rowid <= mark) {
          const t = docText({ chat_jid: chatJid, sender: r.sender, content });
          if (t) {
            const e = exact(t, { teen });
            words.run(d.rowid, e, foldExact(e));
          }
        }
        if (d.episode_id != null) episodes.add(d.episode_id);
        changed++;
      }
    })();
    return { changed, episodes: [...episodes] };
  } finally {
    src.close();
  }
}
function clearEpisodeLabels(ids) {
  const db = open();
  db.transaction(() => {
    for (const id of ids) {
      db.prepare(
        "UPDATE episodes SET topic = NULL, about = NULL, register = NULL, labeled_at = NULL, labeled_n_messages = NULL WHERE id = ?"
      ).run(id);
      db.prepare("DELETE FROM ep_fts WHERE rowid = ?").run(id);
      db.prepare("DELETE FROM ep_words WHERE rowid = ?").run(id);
      db.prepare("DELETE FROM ep_fields WHERE episode_id = ?").run(id);
      db.prepare("DELETE FROM ep_fwords WHERE rowid = ?").run(id);
    }
  })();
}
const SEGMENT_SQL = `
  WITH scope AS (
    SELECT rowid AS rid, chat_jid, timestamp FROM docs
    WHERE (@jid IS NULL OR chat_jid = @jid)
      AND (@from IS NULL OR timestamp >= @from)
  ),
  ordered AS (
    SELECT rid, chat_jid, timestamp,
           ROW_NUMBER() OVER w AS rn,
           LAG(timestamp) OVER w AS prev_ts
    FROM scope
    WINDOW w AS (PARTITION BY chat_jid ORDER BY timestamp, rid)
  ),
  marked AS (
    SELECT rid, chat_jid, timestamp, rn,
           CASE WHEN prev_ts IS NULL
                  OR (julianday(timestamp) - julianday(prev_ts)) * 1440.0 > @gap
                THEN 1 ELSE 0 END AS brk
    FROM ordered
  ),
  bursts AS (
    SELECT rid, chat_jid, timestamp, rn,
           SUM(brk) OVER (PARTITION BY chat_jid ORDER BY rn) AS burst
    FROM marked
  ),
  chunked AS (
    SELECT rid, chat_jid, timestamp, burst,
           (ROW_NUMBER() OVER (PARTITION BY chat_jid, burst ORDER BY rn) - 1)
             / CAST(@cap AS INTEGER) AS chunk
    FROM bursts
  )
  SELECT rid, chat_jid, timestamp,
         MIN(timestamp) OVER (PARTITION BY chat_jid, burst, chunk) AS started_at
  FROM chunked`;
function segment(db, { jid = null, from = null, gap, cap }) {
  return db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS temp.seg");
    db.prepare(`CREATE TEMP TABLE seg AS ${SEGMENT_SQL}`).run({ jid, from, gap, cap });
    db.exec(`
      CREATE INDEX temp.seg_rid ON seg (rid);
      CREATE INDEX temp.seg_key ON seg (chat_jid, started_at);
    `);
    db.prepare(
      `INSERT INTO episodes (chat_jid, started_at, ended_at, n_messages)
         SELECT chat_jid, started_at, MAX(timestamp), COUNT(*)
         FROM seg GROUP BY chat_jid, started_at
       ON CONFLICT(chat_jid, started_at) DO UPDATE
         SET ended_at = excluded.ended_at, n_messages = excluded.n_messages`
    ).run();
    const assigned = db.prepare(
      `UPDATE docs SET episode_id = (
           SELECT e.id FROM seg s
           JOIN episodes e ON e.chat_jid = s.chat_jid AND e.started_at = s.started_at
           WHERE s.rid = docs.rowid)
         WHERE rowid IN (SELECT rid FROM seg)`
    ).run().changes;
    db.prepare(
      `DELETE FROM episodes
       WHERE (@jid IS NULL OR chat_jid = @jid)
         AND (@from IS NULL OR started_at >= @from)
         AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.episode_id = episodes.id)`
    ).run({ jid, from });
    db.exec("DROP TABLE temp.seg");
    return assigned;
  }).immediate();
}
function assignEpisodes({ gap = EPISODE_GAP_MINUTES, cap = EPISODE_MAX_MESSAGES } = {}) {
  const db = open();
  const pending = db.prepare("SELECT DISTINCT chat_jid FROM docs WHERE episode_id IS NULL").all();
  if (!pending.length) return 0;
  const seeded = db.prepare("SELECT 1 FROM episodes LIMIT 1").get();
  if (!seeded) return segment(db, { jid: null, from: null, gap, cap });
  const oldest = db.prepare(
    "SELECT MIN(timestamp) AS t FROM docs WHERE chat_jid = ? AND episode_id IS NULL"
  );
  const anchor = db.prepare(
    `SELECT started_at FROM episodes WHERE chat_jid = ? AND started_at <= ?
     ORDER BY started_at DESC LIMIT 1`
  );
  let assigned = 0;
  for (const { chat_jid } of pending) {
    const t = oldest.get(chat_jid)?.t;
    if (!t) continue;
    const from = anchor.get(chat_jid, t)?.started_at ?? null;
    assigned += segment(db, { jid: chat_jid, from, gap, cap });
  }
  return assigned;
}
function rebuildEpisodes({
  gap = EPISODE_GAP_MINUTES,
  cap = EPISODE_MAX_MESSAGES
} = {}) {
  const db = open();
  const assigned = segment(db, { jid: null, from: null, gap, cap });
  return { assigned, episodes: episodeCount() };
}
function episodeCount() {
  return open().prepare("SELECT COUNT(*) AS n FROM episodes").get().n;
}
function headerLine(ep) {
  if (!ep?.topic) return null;
  const bits = [ep.register, ep.about ? `about ${ep.about}` : null, ep.topic];
  return `≡ ${bits.filter(Boolean).join(" · ")}`;
}
const headerIndexText = (ep) => [ep.topic, ep.about, ep.register].filter(Boolean).join(" ");
function saveEpisodeLabel(id, { topic, about, register, n_messages = null }, { keepExisting = false } = {}) {
  const db = open();
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE episodes
            SET topic = @topic, about = @about, register = @register,
                labeled_at = @at,
                labeled_n_messages = COALESCE(@n, n_messages)
          WHERE id = @id${keepExisting ? " AND topic IS NULL" : ""}`
    ).run({
      id,
      topic: topic ?? null,
      about: about ?? null,
      register: register ?? null,
      n: n_messages,
      at: (/* @__PURE__ */ new Date()).toISOString()
    }).changes;
    if (!changed) return false;
    db.prepare("DELETE FROM ep_fts WHERE rowid = ?").run(id);
    const text = headerIndexText({ topic, about, register });
    if (text) db.prepare("INSERT INTO ep_fts (rowid, header) VALUES (?, ?)").run(id, text);
    const chat = db.prepare("SELECT chat_jid FROM episodes WHERE id = ?").get(id)?.chat_jid ?? null;
    writeLabelWords(db, id, { topic, about, register, chat_jid: chat });
    return true;
  })();
}
function writeLabelWords(db, id, ep) {
  db.prepare("DELETE FROM ep_words WHERE rowid = ?").run(id);
  const text = headerIndexText(ep);
  if (!text) return;
  const e = exact(text, { teen: teenOf(db, ep.chat_jid) });
  db.prepare("INSERT INTO ep_words (rowid, exact, folded) VALUES (?, ?, ?)").run(id, e, foldExact(e));
}
const parseJson = (s, d) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : d;
  } catch {
    return d;
  }
};
const fieldsRow = (r) => r ? {
  people: parseJson(r.people, []),
  keywords: parseJson(r.keywords, []),
  facts: parseJson(r.facts, []),
  status: r.status,
  model: r.model,
  version: r.version,
  n_messages: r.n_messages,
  dropped: r.dropped,
  written_at: r.written_at
} : null;
function episodeFields(id) {
  if (id == null) return null;
  return fieldsRow(open().prepare("SELECT * FROM ep_fields WHERE episode_id = ?").get(id));
}
const fieldsIndexText = (f) => f ? [...f.people ?? [], ...f.keywords ?? [], ...(f.facts ?? []).map((x) => x.text)].filter(Boolean).join(" ; ") : "";
function writeFieldWords(db, id, chatJid, f) {
  db.prepare("DELETE FROM ep_fwords WHERE rowid = ?").run(id);
  const text = fieldsIndexText(f);
  if (!text) return;
  const e = exact(text, { teen: teenOf(db, chatJid) });
  db.prepare("INSERT INTO ep_fwords (rowid, exact, folded) VALUES (?, ?, ?)").run(id, e, foldExact(e));
}
function rebuildFieldWords(db) {
  return db.transaction(() => {
    db.prepare("INSERT INTO ep_fwords (ep_fwords) VALUES ('delete-all')").run();
    const rows = db.prepare("SELECT * FROM ep_fields WHERE status = 'ok'").all();
    for (const r of rows) writeFieldWords(db, r.episode_id, r.chat_jid, fieldsRow(r));
    return rows.length;
  }).immediate();
}
function vetFields(db, ep, raw) {
  const c = cleanFields(raw ?? {}, { resolve: (n) => resolvePerson(ep.chat_jid, n)?.name ?? null, factsMax: Infinity });
  const inConv = new Set(db.prepare("SELECT id FROM docs WHERE episode_id = ?").pluck().all(ep.id).map(String));
  const facts = [];
  const droppedFacts = [];
  let trimmed = c.trimmed;
  for (const f of c.facts) {
    if (!(f.msgs.length && f.msgs.every((m) => inConv.has(String(m)))))
      droppedFacts.push({ ...f, why: f.msgs.length ? "cites a message outside the conversation" : "no citation" });
    else if (facts.length < FACTS_MAX) facts.push(f);
    else trimmed++;
  }
  return { fields: { people: c.people, keywords: c.keywords, facts }, dropped: droppedFacts.length, droppedFacts, trimmed };
}
function checkEpisodeFields(id, raw) {
  const db = open();
  const ep = db.prepare("SELECT id, chat_jid, n_messages FROM episodes WHERE id = ?").get(id);
  return ep ? vetFields(db, ep, raw) : null;
}
function saveEpisodeFields(id, raw, { model = null, status = "ok", replace = false } = {}) {
  const db = open();
  return db.transaction(() => {
    const ep = db.prepare("SELECT id, chat_jid, n_messages FROM episodes WHERE id = ?").get(id);
    if (!ep) return { saved: false, reason: "gone" };
    const have = db.prepare("SELECT status FROM ep_fields WHERE episode_id = ?").get(id);
    if (have && !replace && !(have.status === "refused" && status === "ok")) return { saved: false, reason: "exists" };
    const ok = status === "ok";
    if (!["ok", "refused", "skipped"].includes(status)) throw new Error(`saveEpisodeFields: unknown status ${status}`);
    const { fields, dropped, trimmed } = ok ? vetFields(db, ep, raw) : { fields: { people: [], keywords: [], facts: [] }, dropped: 0, trimmed: 0 };
    db.prepare(
      `INSERT OR REPLACE INTO ep_fields
           (episode_id, chat_jid, people, keywords, facts, status, model, version, n_messages, dropped, written_at)
         VALUES (@id, @chat, @people, @keywords, @facts, @status, @model, @version, @n, @dropped, @at)`
    ).run({
      id,
      chat: ep.chat_jid,
      people: JSON.stringify(fields.people),
      keywords: JSON.stringify(fields.keywords),
      facts: JSON.stringify(fields.facts),
      status,
      model,
      version: LABEL_VERSION,
      n: ep.n_messages,
      dropped,
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    writeFieldWords(db, id, ep.chat_jid, ok ? fields : null);
    return { saved: true, kept: fields.facts.length, dropped, trimmed, reason: null };
  }).immediate();
}
function saveLabelResult(id, r, { model = null } = {}) {
  if (!r) return { label: false, fields: false, kept: 0, dropped: 0, refused: false, stale: false };
  if (r.key && rowsKey(episodeRows(id)) !== r.key)
    return { label: false, fields: false, kept: 0, dropped: 0, refused: false, stale: true };
  if (r.status === "refused") {
    const s2 = saveEpisodeFields(id, null, { model, status: "refused" });
    return { label: false, fields: s2.saved, kept: 0, dropped: 0, refused: true, stale: false };
  }
  const label = r.kind === "full" || r.kind === "core" ? saveEpisodeLabel(id, r, { keepExisting: true }) : false;
  const s = r.kind === "full" || r.kind === "fields" ? saveEpisodeFields(id, r, { model }) : null;
  return { label, fields: s?.saved ?? false, kept: s?.kept ?? 0, dropped: s?.dropped ?? 0, refused: false, stale: false };
}
function secretReason(id) {
  return secretLike(episodeRows(id));
}
function markSkipped(id, reason) {
  return saveEpisodeFields(id, null, { model: `skipped: ${reason}`, status: "skipped" }).saved;
}
function fieldlessEpisodes({
  limit = 100,
  chatJid = null,
  chats = null,
  endedBefore = null,
  endedAfter = null,
  order = "oldest",
  retryRefused = false
} = {}) {
  return open().prepare(
    `SELECT e.id, e.chat_jid, e.started_at, e.ended_at, e.n_messages, e.topic, e.about, e.register
         FROM episodes e LEFT JOIN ep_fields f ON f.episode_id = e.id
        WHERE e.topic IS NOT NULL
          AND (f.episode_id IS NULL OR (@retry = 1 AND f.status = 'refused'))
          AND (@jid IS NULL OR e.chat_jid = @jid)
          AND (@chats IS NULL OR e.chat_jid IN (SELECT value FROM json_each(@chats)))
          AND (@before IS NULL OR e.ended_at <= @before)
          AND (@after IS NULL OR e.ended_at >= @after)
        ORDER BY e.ended_at ${order === "newest" ? "DESC" : "ASC"}, e.id
        LIMIT @limit`
  ).all({
    jid: chatJid,
    chats: chats ? JSON.stringify(chats) : null,
    before: endedBefore,
    after: endedAfter,
    retry: retryRefused ? 1 : 0,
    limit
  });
}
function fieldStats({ chatJid = null, chats = null } = {}) {
  return open().prepare(
    `SELECT COUNT(*) AS episodes,
              COALESCE(SUM(e.topic IS NOT NULL), 0) AS labelled,
              COALESCE(SUM(f.status = 'ok'), 0) AS fields,
              COALESCE(SUM(f.status = 'refused'), 0) AS refused,
              COALESCE(SUM(f.status = 'skipped'), 0) AS skipped,
              COALESCE(SUM(e.topic IS NOT NULL AND f.episode_id IS NULL), 0) AS pending_fields,
              COALESCE(SUM(e.topic IS NULL AND f.episode_id IS NULL), 0) AS pending_full,
              COALESCE(SUM(f.dropped), 0) AS dropped_facts,
              COALESCE(SUM(CASE WHEN f.status = 'ok' THEN json_array_length(f.facts) ELSE 0 END), 0) AS facts
         FROM episodes e LEFT JOIN ep_fields f ON f.episode_id = e.id
        WHERE (@jid IS NULL OR e.chat_jid = @jid)
          AND (@chats IS NULL OR e.chat_jid IN (SELECT value FROM json_each(@chats)))`
  ).get({ jid: chatJid, chats: chats ? JSON.stringify(chats) : null });
}
function factsLine(ep) {
  const f = ep?.fields !== void 0 ? ep.fields : episodeFields(ep?.id);
  const facts = (f?.facts ?? []).map((x) => String(x?.text ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!facts.length) return null;
  const cut = (s, n) => s.length > n ? `${s.slice(0, n - 1).trim()}…` : s;
  const parts = facts.slice(0, FACTS_SHOW).map((s) => cut(s.replace(/[.;]+$/, ""), FACT_SHOW_CHARS));
  let line = `≡ facts: ${parts.join(" · ")}`;
  if (line.length > FACTS_LINE_CHARS) line = cut(line, FACTS_LINE_CHARS);
  return line;
}
const TEEN_VI_SHARE = 0.2;
const TEEN_MIN_DOCS = 30;
const VI_LETTER_RE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/;
const teenCache = /* @__PURE__ */ new Map();
function decideChat(db, chatJid) {
  const contents = db.prepare("SELECT content FROM docs WHERE chat_jid = ? AND content IS NOT NULL AND content != ''").pluck().all(chatJid);
  let vi = 0;
  for (const c of contents) if (VI_LETTER_RE.test(c.normalize("NFC").toLowerCase())) vi++;
  const n = contents.length;
  return { teen: n > 0 && vi / n >= TEEN_VI_SHARE ? 1 : 0, docs: n, vi, final: n >= TEEN_MIN_DOCS ? 1 : 0 };
}
function reindexChat(db, chatJid, teen) {
  const mark = Number(getMeta("words_mark") ?? 0);
  const ins = db.prepare("INSERT OR REPLACE INTO msg_words (rowid, exact, folded) VALUES (?, ?, ?)");
  for (const r of db.prepare("SELECT rowid, chat_jid, sender, content FROM docs WHERE chat_jid = ? AND rowid <= ?").all(chatJid, mark)) {
    const t = docText(r);
    if (!t) continue;
    const e = exact(t, { teen: Boolean(teen) });
    ins.run(r.rowid, e, foldExact(e));
  }
  for (const ep of db.prepare("SELECT id, chat_jid, topic, about, register FROM episodes WHERE chat_jid = ? AND topic IS NOT NULL").all(chatJid))
    writeLabelWords(db, ep.id, ep);
  for (const r of db.prepare("SELECT * FROM ep_fields WHERE chat_jid = ? AND status = 'ok'").all(chatJid))
    writeFieldWords(db, r.episode_id, r.chat_jid, fieldsRow(r));
}
function teenOf(db, chatJid) {
  if (TEEN_POLICY === "all") return true;
  if (!chatJid) return false;
  const hit = teenCache.get(chatJid);
  if (hit?.final) return Boolean(hit.teen);
  const row = db.prepare("SELECT teen, final FROM chat_norm WHERE chat_jid = ?").get(chatJid);
  if (row?.final) {
    teenCache.set(chatJid, { teen: row.teen, final: 1 });
    return Boolean(row.teen);
  }
  const now = db.prepare("SELECT COUNT(*) FROM docs WHERE chat_jid = ?").pluck().get(chatJid);
  if (row && hit && hit.at === now) return Boolean(row.teen);
  const d = decideChat(db, chatJid);
  db.prepare(
    `INSERT INTO chat_norm (chat_jid, teen, docs, vi, final, decided_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET teen = excluded.teen, docs = excluded.docs, vi = excluded.vi,
       final = excluded.final, decided_at = excluded.decided_at`
  ).run(chatJid, d.teen, d.docs, d.vi, d.final, (/* @__PURE__ */ new Date()).toISOString());
  teenCache.set(chatJid, { teen: d.teen, final: d.final, at: now });
  if (row && row.teen !== d.teen) reindexChat(db, chatJid, d.teen);
  return Boolean(d.teen);
}
function teenModeFor(chatJid) {
  if (TEEN_POLICY === "all") return "on";
  const s = chatScope(chatJid);
  if (!s) return "both";
  const rows = open().prepare(`SELECT teen FROM chat_norm WHERE chat_jid IN (${s.map(() => "?").join(", ")})`).pluck().all(...s);
  if (!rows.length) return "both";
  if (rows.every((t) => t)) return "on";
  if (rows.every((t) => !t)) return "off";
  return "both";
}
let teenMode = "on";
function withScope(chatJid, fn) {
  const prev = teenMode;
  teenMode = teenModeFor(chatJid);
  try {
    return fn();
  } finally {
    teenMode = prev;
  }
}
function wordIndexReady() {
  return getMeta("words_ready") === "1" && getMeta("words_version") === WORDS_VERSION;
}
const pause = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
function indexWords({ batch = 5e3, onProgress = null, pauseMs = 0 } = {}) {
  const db = open();
  const sel = db.prepare("SELECT rowid, chat_jid, sender, content FROM docs WHERE rowid > ? ORDER BY rowid LIMIT ?");
  const ins = db.prepare("INSERT OR REPLACE INTO msg_words (rowid, exact, folded) VALUES (?, ?, ?)");
  const step = db.transaction(() => {
    const mark = Number(getMeta("words_mark") ?? 0);
    const rows = sel.all(mark, batch);
    for (const r of rows) {
      const text = docText(r);
      if (!text) continue;
      const e = exact(text, { teen: teenOf(db, r.chat_jid) });
      ins.run(r.rowid, e, foldExact(e));
    }
    if (rows.length) setMeta("words_mark", rows[rows.length - 1].rowid);
    return rows.length;
  });
  let total = 0;
  for (; ; ) {
    const n = step.immediate();
    total += n;
    if (n) onProgress?.(total);
    if (n < batch) break;
    pause(pauseMs);
  }
  return total;
}
const maxLabeledAt = (db) => db.prepare("SELECT MAX(labeled_at) AS m FROM episodes").get().m ?? "";
function rebuildLabelWords(db) {
  return db.transaction(() => {
    db.prepare("INSERT INTO ep_words (ep_words) VALUES ('delete-all')").run();
    const eps = db.prepare("SELECT id, chat_jid, topic, about, register FROM episodes WHERE topic IS NOT NULL").all();
    for (const e of eps) writeLabelWords(db, e.id, e);
    setMeta("words_label_mark", maxLabeledAt(db));
    return eps.length;
  }).immediate();
}
function catchUpLabels(db) {
  const mark = getMeta("words_label_mark");
  if (mark === null) return rebuildLabelWords(db);
  if (!db.prepare("SELECT 1 FROM episodes WHERE labeled_at > ? LIMIT 1").get(mark)) return 0;
  return db.transaction(() => {
    const eps = db.prepare(
      `SELECT id, chat_jid, topic, about, register, labeled_at FROM episodes
            WHERE labeled_at > ? ORDER BY labeled_at`
    ).all(getMeta("words_label_mark") ?? "");
    for (const e of eps) writeLabelWords(db, e.id, e);
    if (eps.length) setMeta("words_label_mark", eps[eps.length - 1].labeled_at);
    return eps.length;
  }).immediate();
}
function catchUpWords() {
  if (!wordIndexReady()) return { docs: 0, labels: 0 };
  const db = open();
  const max = db.prepare("SELECT MAX(rowid) AS m FROM docs").get().m ?? 0;
  const docs = max > Number(getMeta("words_mark") ?? 0) ? indexWords() : 0;
  return { docs, labels: catchUpLabels(db) };
}
function buildWordIndex({ rebuild = false, batch = 5e3, onProgress = null, pauseMs = 0 } = {}) {
  const db = open();
  const t0 = Date.now();
  const stale = getMeta("words_version") !== WORDS_VERSION;
  const restart = rebuild || stale;
  if (restart) {
    db.transaction(() => {
      db.prepare("INSERT INTO msg_words (msg_words) VALUES ('delete-all')").run();
      db.prepare("DELETE FROM chat_norm").run();
      teenCache.clear();
      setMeta("words_ready", "0");
      setMeta("words_mark", "0");
      setMeta("words_version", WORDS_VERSION);
    }).immediate();
  }
  const from = Number(getMeta("words_mark") ?? 0);
  const labels = rebuildLabelWords(db);
  const fields = rebuildFieldWords(db);
  const docs = indexWords({ batch, onProgress, pauseMs });
  setMeta("words_ready", "1");
  return { restarted: restart, resumedFrom: restart ? 0 : from, docs, labels, fields, ms: Date.now() - t0 };
}
function wordIndexStats() {
  const db = open();
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const labelMark = getMeta("words_label_mark");
  return {
    ready: wordIndexReady(),
    version: getMeta("words_version"),
    codeVersion: WORDS_VERSION,
    teenPolicy: TEEN_POLICY,
    teenChats: TEEN_POLICY === "detect" ? n("SELECT COUNT(*) AS n FROM chat_norm WHERE teen = 1") : null,
    plainChats: TEEN_POLICY === "detect" ? n("SELECT COUNT(*) AS n FROM chat_norm WHERE teen = 0") : null,
    mark: Number(getMeta("words_mark") ?? 0),
    maxDoc: n("SELECT COALESCE(MAX(rowid), 0) AS n FROM docs"),
    pending: n("SELECT COUNT(*) AS n FROM docs WHERE rowid > ?", Number(getMeta("words_mark") ?? 0)),
    labels: n("SELECT COUNT(*) AS n FROM episodes WHERE topic IS NOT NULL"),
    fields: n("SELECT COUNT(*) AS n FROM ep_fields WHERE status = 'ok'"),
    labelMark,
    pendingLabels: labelMark === null ? null : n("SELECT COUNT(*) AS n FROM episodes WHERE labeled_at > ?", labelMark)
  };
}
function unlabeledEpisodes({
  limit = 100,
  chatJid = null,
  chats = null,
  endedBefore = null,
  endedAfter = null,
  order = "oldest",
  // Phase 3: leave out a conversation whose labelling was REFUSED or that was
  // deliberately never sent (an ep_fields row, status "refused" / "skipped"),
  // so it is not paid for again on every run. Off by default — Phase 2's.
  skipRefused = false
} = {}) {
  return open().prepare(
    `SELECT id, chat_jid, started_at, ended_at, n_messages FROM episodes
        WHERE topic IS NULL
          AND (@jid IS NULL OR chat_jid = @jid)
          AND (@chats IS NULL OR chat_jid IN (SELECT value FROM json_each(@chats)))
          AND (@before IS NULL OR ended_at <= @before)
          AND (@after IS NULL OR ended_at >= @after)
          AND (@skip = 0 OR NOT EXISTS (SELECT 1 FROM ep_fields f WHERE f.episode_id = episodes.id))
        ORDER BY ended_at ${order === "newest" ? "DESC" : "ASC"}, id
        LIMIT @limit`
  ).all({
    jid: chatJid,
    chats: chats ? JSON.stringify(chats) : null,
    before: endedBefore,
    after: endedAfter,
    skip: skipRefused ? 1 : 0,
    limit
  });
}
function indexStamp(ms = Date.now()) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
function labelStats(chatJid = null) {
  return open().prepare(
    `SELECT COUNT(*) AS total,
              SUM(CASE WHEN topic IS NOT NULL THEN 1 ELSE 0 END) AS labeled,
              SUM(n_messages) AS messages
         FROM episodes WHERE (@jid IS NULL OR chat_jid = @jid)`
  ).get({ jid: chatJid });
}
function getEpisode(id) {
  return open().prepare("SELECT * FROM episodes WHERE id = ?").get(id);
}
function recentLabels({ limit = 20, chatJid = null } = {}) {
  return open().prepare(
    `SELECT * FROM episodes
        WHERE topic IS NOT NULL AND (@jid IS NULL OR chat_jid = @jid)
        ORDER BY labeled_at DESC, id DESC LIMIT @limit`
  ).all({ jid: chatJid, limit });
}
function recordBatch(id, { n_requests, stage = null, status = "in_progress" }) {
  open().prepare(
    `INSERT INTO episode_batches (id, created_at, n_requests, stage, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`
  ).run(id, (/* @__PURE__ */ new Date()).toISOString(), n_requests, stage, status);
}
function openBatches() {
  return open().prepare("SELECT * FROM episode_batches WHERE ingested_at IS NULL ORDER BY created_at").all();
}
function closeBatch(id, status = "ended") {
  open().prepare("UPDATE episode_batches SET status = ?, ingested_at = ? WHERE id = ?").run(status, (/* @__PURE__ */ new Date()).toISOString(), id);
}
const episodeHandle = (id) => `conv:${Number(id).toString(36)}`;
function parseEpisodeHandle(handle) {
  const m = /^(?:conv:)?([0-9a-z]+)$/i.exec(String(handle ?? "").trim());
  if (!m) return null;
  const id = parseInt(m[1], 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function count() {
  return open().prepare("SELECT COUNT(*) AS n FROM docs").get().n;
}
function hasChat(chatJid) {
  const sc = scopeSql("chat_jid", chatJid);
  return Boolean(sc && open().prepare(`SELECT 1 FROM docs WHERE ${sc.sql} LIMIT 1`).get(...sc.params));
}
function parseQuery(input) {
  let items = [];
  const re = /(-?)"([^"]*)"(\*?)|(\S+)/g;
  let m;
  while ((m = re.exec(String(input ?? ""))) !== null) {
    if (m[2] !== void 0) {
      const text = m[2].trim();
      if (text) items.push(term(text, { neg: m[1] === "-", quoted: true, prefix: m[3] === "*" }));
      continue;
    }
    let w = m[4];
    if (w === "OR") {
      items.push({ or: true });
      continue;
    }
    const neg = w.length > 1 && w[0] === "-";
    if (neg) w = w.slice(1);
    const prefix = w.length > 1 && w.endsWith("*");
    if (prefix) w = w.slice(0, -1);
    w = w.replace(/^"+|"+$/g, "");
    if (w) items.push(term(w, { neg, prefix }));
  }
  const dropped = [];
  const wordy = (it) => tokens(it.text).length > 0;
  if (items.some((it) => !it.or && !it.neg && wordy(it))) {
    items = items.filter((it) => {
      if (it.or || wordy(it)) return true;
      dropped.push(`${it.neg ? "-" : ""}${it.text}`);
      return false;
    });
  }
  const clauses = [];
  const negs = [];
  let joinNext = false;
  for (const it of items) {
    if (it.or) {
      joinNext = clauses.length > 0;
      continue;
    }
    if (it.neg) {
      negs.push(it);
      joinNext = false;
      continue;
    }
    if (joinNext) clauses[clauses.length - 1].push([it]);
    else clauses.push([[it]]);
    joinNext = false;
  }
  const posKeys = new Set(clauses.flat(2).map((t) => t.key));
  const ignored = [];
  const keptNegs = [];
  for (const n of negs) {
    if (posKeys.has(n.key)) ignored.push(n.text);
    else if (!keptNegs.some((k) => k.key === n.key)) keptNegs.push(n);
  }
  return { clauses: dedupeClauses(clauses), negs: keptNegs, ignored, dropped, items };
}
function term(text, { neg = false, quoted = false, prefix = false } = {}) {
  return { text, neg, quoted, prefix, key: `${exact(text, { teen: !prefix })}${prefix ? "*" : ""}` };
}
function dedupeClauses(clauses) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of clauses) {
    const alts = [];
    const altSeen = /* @__PURE__ */ new Set();
    for (const a of c) {
      const k2 = a.map((t) => t.key).join(" ");
      if (!altSeen.has(k2)) {
        altSeen.add(k2);
        alts.push(a);
      }
    }
    const k = alts.map((a) => a.map((t) => t.key).join(" ")).sort().join("|");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(alts);
    }
  }
  return out;
}
function orGroups(q) {
  const segs = [[]];
  for (const it of q.items ?? []) {
    if (it.or) segs.push([]);
    else if (!it.neg) segs[segs.length - 1].push(it);
  }
  const groups = segs.filter((s) => s.length);
  if (groups.length < 2 || !groups.some((s) => s.length > 1)) return null;
  return { clauses: [groups], negs: q.negs, ignored: q.ignored, items: q.items, grouped: true };
}
function anyWordQuery(q) {
  if (q.clauses.length < 2) return null;
  return { clauses: [q.clauses.flat()], negs: q.negs, ignored: q.ignored, items: [], anyWord: true };
}
const fmtTerm = (t) => `${t.neg ? "-" : ""}${t.quoted || /[\s"]/.test(t.text) ? ftsQuote(t.text) : t.text}${t.prefix ? "*" : ""}`;
const fmtAlt = (a, inOr) => a.length > 1 && inOr ? `(${a.map(fmtTerm).join(" ")})` : a.map(fmtTerm).join(" ");
const fmtClause = (c) => c.map((a) => fmtAlt(a, c.length > 1)).join(" OR ");
const formatQuery = (q) => [...q.clauses.map(fmtClause), ...q.negs.map(fmtTerm)].join(" ");
const ftsQuote = (s) => `"${s.replace(/"/g, '""')}"`;
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);
function termForms(t) {
  const out = [];
  const add = (s) => {
    const e = tokens(s).join(" ");
    if (!e || out.some((o) => o.e === e)) return;
    const f = tokens(foldExact(s)).join(" ");
    out.push({ e, f, accented: e !== f });
  };
  if (t.prefix) add(exact(t.text, { teen: false }));
  else {
    if (teenMode !== "off") add(exact(t.text));
    if (teenMode !== "on") add(exact(t.text, { teen: false }));
  }
  return out;
}
const phrase = (p, prefix) => `"${p}"${prefix ? " *" : ""}`;
const anyOfParts = (parts) => parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
function termExpr(t, mode) {
  const forms = termForms(t);
  if (!forms.length) return null;
  const m = t.mode ?? mode;
  const parts = forms.map(
    ({ e, f, accented }) => m === "exact" || m === "accentedExact" && accented ? `{exact}: ${phrase(e, t.prefix)}` : `({exact}: ${phrase(e, t.prefix)} OR {folded}: ${phrase(f, t.prefix)})`
  );
  if (t.infl) {
    for (const w of t.infl.forms) parts.push(`{folded}: ${phrase(w, false)}`);
    for (const p of t.infl.prefixes) parts.push(`{folded}: ${phrase(p, true)}`);
  }
  return anyOfParts(parts);
}
const INFLECT_MIN_PREFIX = 5;
function wordForms(word) {
  const w = String(word ?? "");
  if (!/^[a-z]+$/.test(w) || w.length < 4) return null;
  const prefixes = /* @__PURE__ */ new Set();
  const forms = /* @__PURE__ */ new Set();
  const regular = (b) => {
    forms.add(b);
    if (b.endsWith("e")) for (const s of [`${b}s`, `${b}d`, `${b.slice(0, -1)}ing`]) forms.add(s);
    else {
      for (const s of [`${b}s`, `${b}ed`, `${b}ing`]) forms.add(s);
      if (/[^aeiou][aeiou][^aeiouwxy]$/.test(b)) for (const s of ["ed", "ing"]) forms.add(`${b}${b.at(-1)}${s}`);
    }
  };
  const stem = (b) => {
    if (b.length >= INFLECT_MIN_PREFIX) prefixes.add(b);
    else if (b.length === 4) regular(b);
  };
  stem(w);
  const n = w.length;
  if (n >= 6 && w.endsWith("ies")) stem(`${w.slice(0, -3)}y`);
  else if (n >= 6 && w.endsWith("es") && /(s|x|z|ch|sh)$/.test(w.slice(0, -2))) stem(w.slice(0, -2));
  else if (n >= 5 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) stem(w.slice(0, -1));
  else if (n >= 6 && w.endsWith("ed")) stem(w.slice(0, -2));
  else if (n >= 7 && w.endsWith("ing")) stem(w.slice(0, -3));
  forms.delete(w);
  for (const p of [...prefixes]) if ([...prefixes].some((o) => o !== p && p.startsWith(o))) prefixes.delete(p);
  for (const f of [...forms]) if ([...prefixes].some((p) => f.startsWith(p))) forms.delete(f);
  return prefixes.size || forms.size ? { prefixes: [...prefixes], forms: [...forms] } : null;
}
function inflectQuery(q) {
  if (teenMode === "on") return null;
  let any = false;
  const clauses = q.clauses.map(
    (c) => c.map(
      (a) => a.map((t) => {
        if (t.quoted || t.prefix || t.neg) return t;
        const w = exact(t.text, { teen: false });
        if (w !== exact(t.text)) return t;
        const infl = wordForms(w);
        if (!infl) return t;
        any = true;
        return { ...t, infl };
      })
    )
  );
  return any ? { ...q, clauses } : null;
}
const NOT_VIETNAMESE_SQL = "d.chat_jid NOT IN (SELECT chat_jid FROM chat_norm WHERE teen = 1)";
function negExpr(t) {
  const forms = termForms(t);
  if (!forms.length) return null;
  return anyOfParts(
    forms.map(({ e, f, accented }) => accented ? `{exact}: ${phrase(e, t.prefix)}` : `{folded}: ${phrase(f, t.prefix)}`)
  );
}
const wrap = (parts, op) => parts.length > 1 ? `(${parts.join(` ${op} `)})` : parts[0];
function altExpr(a, mode) {
  const parts = a.map((t) => termExpr(t, mode));
  return parts.some((p) => !p) ? null : wrap(parts, "AND");
}
function clauseExpr(c, mode) {
  const parts = c.map((a) => altExpr(a, mode));
  return parts.some((p) => !p) ? null : wrap(parts, "OR");
}
function withNegs(expr, q) {
  const negs = q.negs.map(negExpr).filter(Boolean);
  return negs.length ? `(${expr}) NOT (${negs.join(" OR ")})` : expr;
}
function wordExpr(q, mode = "both") {
  if (!q.clauses.length) return null;
  const parts = q.clauses.map((c) => clauseExpr(c, mode));
  if (parts.some((p) => !p)) return null;
  return withNegs(parts.join(" AND "), q);
}
function labelExpr(q) {
  const parts = q.clauses.flat().map((a) => altExpr(a, "both")).filter(Boolean);
  return parts.length ? withNegs(parts.join(" OR "), q) : null;
}
const allTerms = (q) => [...q.clauses.flat(2), ...q.negs];
function phraseQuery(q) {
  const items = q.items ?? [];
  if (items.some((i) => i.or)) return null;
  const pos = items.filter((i) => !i.neg);
  if (pos.length < 2 || pos.some((i) => i.prefix)) return null;
  return { clauses: [[[term(pos.map((i) => i.text).join(" "), { quoted: true })]]], negs: q.negs, items: [] };
}
const wordable = (q) => q.clauses.length > 0 && allTerms(q).every((t) => !isUnspaced(t.text) && termForms(t).length > 0);
const typedAccents = (t) => /[\u0300-\u036f]|đ/i.test(String(t.text).normalize("NFD"));
const anyAccented = (q) => q.clauses.flat(2).some(typedAccents);
const asTyped = (q) => ({
  ...q,
  clauses: q.clauses.map((c) => c.map((a) => a.map((t) => typedAccents(t) ? { ...t, mode: "exact" } : t)))
});
const isShort = (t) => [...t.text].length < 3;
function trigramMatch(q, col) {
  const where = [];
  const params = [];
  const fts = [];
  for (const c of q.clauses) {
    if (c.every((a) => a.every((t) => !isShort(t)))) {
      fts.push(wrap(c.map((a) => wrap(a.map((t) => ftsQuote(t.text)), "AND")), "OR"));
      continue;
    }
    where.push(`(${c.map((a) => `(${a.map(() => `${col} LIKE ? ESCAPE '\\'`).join(" AND ")})`).join(" OR ")})`);
    for (const a of c) for (const t of a) params.push(`%${likeEscape(t.text)}%`);
  }
  let expr = fts.length ? fts.join(" AND ") : null;
  const longNeg = q.negs.filter((t) => !isShort(t));
  if (expr && longNeg.length) expr = `(${expr}) NOT (${longNeg.map((t) => ftsQuote(t.text)).join(" OR ")})`;
  for (const t of q.negs) {
    if (expr && !isShort(t)) continue;
    where.push(`${col} NOT LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(t.text)}%`);
  }
  return { expr, where, params };
}
const wordTerm = (t) => !isUnspaced(t.text) && termForms(t).length > 0;
function splitMixed(q) {
  if (!q.clauses.length || !wordIndexReady() || wordable(q)) return null;
  const wc = [];
  const uc = [];
  for (const c of q.clauses) (c.every((a) => a.every(wordTerm)) ? wc : uc).push(c);
  if (!wc.length) return null;
  const wn = q.negs.filter(wordTerm);
  const un = q.negs.filter((t) => !wordTerm(t));
  return { words: { ...q, clauses: wc, negs: wn, items: [] }, rest: { clauses: uc, negs: un } };
}
function likeWhere(rest, col = "d.content") {
  const where = [];
  const params = [];
  for (const c of rest.clauses) {
    where.push(`(${c.map((a) => `(${a.map(() => `${col} LIKE ? ESCAPE '\\'`).join(" AND ")})`).join(" OR ")})`);
    for (const a of c) for (const t of a) params.push(`%${likeEscape(t.text)}%`);
  }
  for (const t of rest.negs) {
    where.push(`${col} NOT LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(t.text)}%`);
  }
  return { where, params };
}
function clauseDf(db, c, chatJid, where = "messages") {
  return queryDf(db, { clauses: [c], negs: [] }, chatJid, where, { asTyped: true });
}
function queryDf(db, q0, chatJid, where = "messages", { asTyped: typed = false } = {}) {
  const q = typed ? asTyped(q0) : q0;
  const sd = scopeSql("d.chat_jid", chatJid);
  const jid = sd ? ` AND ${sd.sql}` : "";
  const p = sd ? sd.params : [];
  if (where === "labels") {
    const lq = labelQuery(q);
    const expr = wordIndexReady() && wordable(q) && lq.clauses.length ? labelExpr(lq) : null;
    if (!expr) return 0;
    const se = scopeSql("e.chat_jid", chatJid);
    const df = (table) => db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} CROSS JOIN episodes e ON e.id = ${table}.rowid
            WHERE ${table} MATCH ?${se ? ` AND ${se.sql}` : ""}`
    ).get(expr, ...se ? se.params : []).n;
    return df("ep_words") + (fieldsFuseWeight() > 0 ? df("ep_fwords") : 0);
  }
  if (wordIndexReady() && wordable(q)) {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM msg_words w CROSS JOIN docs d ON d.rowid = w.rowid
          WHERE msg_words MATCH ?${jid}`
    ).get(wordExpr(q), ...p).n;
  }
  const mixed = splitMixed(q);
  if (mixed) {
    const lw = likeWhere(mixed.rest);
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM msg_words w CROSS JOIN docs d ON d.rowid = w.rowid
          WHERE msg_words MATCH ?${lw.where.map((x) => ` AND ${x}`).join("")}${jid}`
    ).get(wordExpr(mixed.words), ...lw.params, ...p).n;
    if (n) return n;
  }
  const m = trigramMatch(q, "d.content");
  const from = m.expr ? "msg_fts CROSS JOIN docs d ON d.rowid = msg_fts.rowid" : "docs d";
  const w = [...m.expr ? ["msg_fts MATCH ?"] : [], ...m.where];
  return db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w.join(" AND ") || "1"}${jid}`).get(...m.expr ? [m.expr] : [], ...m.params, ...p).n;
}
function termFrequencies(input, { chatJid = null } = {}) {
  const db = open();
  const q = parseQuery(String(input ?? ""));
  return withScope(chatJid, () => q.clauses.map((c) => ({ text: fmtClause(c), df: clauseDf(db, c, chatJid) })));
}
const RELAX_MIN_MATCHES = 3;
const RELAX_PARTICLES = new Set(
  "j z r k ko hok hk gì vậy nào nhé nha hả ạ ơi à á thế mấy nhiêu nhiu không ah lah leh lor meh hor sia liao much many per".split(" ")
);
function relaxStopClause(c) {
  const raw = String(fmtClause(c)).toLowerCase().replace(/['’]s\b/g, "");
  const ws = tokens(raw);
  return ws.length > 0 && ws.every((w) => LABEL_STOPWORDS.has(fold(w)) || RELAX_PARTICLES.has(w) || RELAX_PARTICLES.has(exact(w)));
}
function relaxQuery(input, opts = {}) {
  return withScope(opts.chatJid ?? null, () => relaxQueryIn(input, opts));
}
function relaxQueryIn(input, { chatJid = null, keep = 2, maxWords = 3, minMatches = RELAX_MIN_MATCHES } = {}) {
  const db = open();
  const q = parseQuery(String(input ?? ""));
  if (q.clauses.length <= keep) return null;
  const scored = q.clauses.map((c) => ({ c, df: clauseDf(db, c, chatJid) + clauseDf(db, c, chatJid, "labels") })).filter((s) => s.df > 0);
  if (!scored.length) return null;
  const len = (c) => [...fmtClause(c)].length;
  scored.sort((a, b) => a.df - b.df || len(b.c) - len(a.c));
  const content = scored.filter((x) => !relaxStopClause(x.c));
  if (content.length) scored.splice(0, scored.length, ...content);
  let picked = scored.slice(0, keep);
  const top = Math.min(maxWords, scored.length === q.clauses.length ? scored.length - 1 : scored.length);
  for (let k = top; k > keep; k--) {
    const cand = scored.slice(0, k);
    if (queryDf(db, { clauses: cand.map((s) => s.c), negs: q.negs }, chatJid) >= minMatches) {
      picked = cand;
      break;
    }
  }
  const order = new Map(q.clauses.map((c, i) => [c, i]));
  picked.sort((a, b) => order.get(a.c) - order.get(b.c));
  const query = formatQuery({ clauses: picked.map((p) => p.c), negs: q.negs });
  if (query === String(input ?? "").trim()) return null;
  return {
    query,
    kept: picked.map((p) => ({ text: fmtClause(p.c), df: p.df })),
    dropped: q.clauses.filter((c) => !picked.some((p) => p.c === c)).map(fmtClause)
  };
}
function aboutValues(db, chatJid, about) {
  const match = aboutMatcher(chatJid, about);
  const sc = scopeSql("chat_jid", chatJid);
  return db.prepare(`SELECT DISTINCT about FROM episodes WHERE about IS NOT NULL${sc ? ` AND ${sc.sql}` : ""}`).all(...sc ? sc.params : []).map((r) => r.about).filter(match);
}
function aboutFilter(db, chatJid, about) {
  const list = aboutValues(db, chatJid, about);
  const { keys, column } = wordIndexReady() ? aboutKeys(chatJid, about) : { keys: [], column: "folded" };
  const norm = (k) => termForms(term(k)).map((fm) => column === "exact" ? fm.e : fm.f);
  const poss = [...new Set(keys.flatMap(norm).filter(Boolean))].map((k) => `{${column}}: "${k} s"`);
  if (!list.length && !poss.length) return null;
  const parts = [];
  const params = [];
  if (list.length) {
    parts.push("SELECT id FROM episodes WHERE about IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(list));
  }
  if (poss.length) {
    parts.push("SELECT rowid FROM ep_words WHERE ep_words MATCH ?");
    params.push(poss.join(" OR "));
  }
  return { sql: parts.join(" UNION "), params };
}
function docFilters({ chatJid, senders, after, before, mediaOnly }, aboutF) {
  const where = [];
  const params = [];
  if (aboutF) {
    where.push(`d.episode_id IN (${aboutF.sql})`);
    params.push(...aboutF.params);
  }
  const sc = scopeSql("d.chat_jid", chatJid);
  if (sc) {
    where.push(sc.sql);
    params.push(...sc.params);
  }
  if (senders?.length) {
    where.push(`d.sender IN (${senders.map(() => "?").join(",")})`);
    params.push(...senders);
    const bot = botRowSql("d");
    if (bot) where.push(`NOT ${bot}`);
  }
  if (after) {
    where.push("d.timestamp >= ?");
    params.push(lowBound(after));
  }
  if (before) {
    where.push("d.timestamp <= ?");
    params.push(highBound(before));
  }
  if (mediaOnly) where.push("d.media_type IS NOT NULL AND d.media_type != ''");
  return { where, params };
}
function runDocQuery(db, { from, match, expr, where, params, rank }, filt, { sort, limit, counts = true }) {
  const w = [...expr ? [`${match} MATCH ?`] : [], ...where, ...filt.where];
  const p = [...expr ? [expr] : [], ...params, ...filt.params];
  const clause = w.length ? w.join(" AND ") : "1";
  let epCounts = /* @__PURE__ */ new Map();
  let matched = null;
  if (counts) {
    const groups = db.prepare(`SELECT d.episode_id AS ep, COUNT(*) AS n FROM ${from} WHERE ${clause} GROUP BY d.episode_id`).all(...p);
    epCounts = new Map(groups.map((r) => [r.ep, r.n]));
    matched = groups.reduce((s, r) => s + r.n, 0);
    if (!matched) return { rows: [], matched: 0, epCounts };
  }
  const order = sort === "recent" || !expr ? "d.timestamp DESC" : `${rank} * MIN(1.0, 0.3 + LENGTH(d.content) / 50.0), d.timestamp DESC`;
  const rows = db.prepare(
    `SELECT d.id, d.chat_jid, d.sender, d.content, d.timestamp,
              d.is_from_me, d.media_type, d.quoted_id, d.episode_id
       FROM ${from}
       WHERE ${clause} ORDER BY ${order} LIMIT ?`
  ).all(...p, limit);
  return { rows, matched, epCounts };
}
function searchIndex(opts) {
  return withScope(opts?.chatJid ?? null, () => searchIndexIn(opts));
}
function searchIndexIn({
  query,
  parsed = null,
  chatJid = null,
  senders = null,
  about = null,
  after = null,
  before = null,
  mediaOnly = null,
  sort = "relevance",
  limit = 20,
  partialFallback = true
}) {
  const db = open();
  const q = parsed ?? parseQuery(query ?? "");
  const none = { rows: [], matched: 0, matchedExact: null, epCounts: /* @__PURE__ */ new Map(), partial: false, path: null };
  if (!q.clauses.length && !q.negs.length && !about && !senders?.length && !after && !before)
    return none;
  const aboutF = about ? aboutFilter(db, chatJid, about) : null;
  if (about && !aboutF) return none;
  const filt = docFilters({ chatJid, senders, after, before, mediaOnly }, aboutF);
  const opts = { sort, limit };
  const trigram = () => {
    const m = trigramMatch(q, "d.content");
    return runDocQuery(
      db,
      {
        from: m.expr ? "msg_fts CROSS JOIN docs d ON d.rowid = msg_fts.rowid" : "docs d",
        match: "msg_fts",
        expr: m.expr,
        where: m.where,
        params: m.params,
        rank: "bm25(msg_fts)"
      },
      filt,
      opts
    );
  };
  if (q.clauses.length && wordIndexReady() && wordable(q)) {
    const from = "msg_words w CROSS JOIN docs d ON d.rowid = w.rowid";
    const rank = `bm25(msg_words, ${WORD_WEIGHTS.join(", ")})`;
    const words = (expr, o = opts) => runDocQuery(db, { from, match: "msg_words", expr, where: [], params: [], rank }, filt, o);
    const key = (r) => `${r.chat_jid}:${r.id}`;
    let res = words(wordExpr(q));
    let exactRows = res.rows;
    let inflRows = [];
    const qi = inflectQuery(q);
    if (qi) {
      const ri = runDocQuery(
        db,
        { from, match: "msg_words", expr: wordExpr(qi), where: [NOT_VIETNAMESE_SQL], params: [], rank },
        filt,
        opts
      );
      const seen = new Set(res.rows.map(key));
      inflRows = ri.rows.filter((r) => !seen.has(key(r)));
      if (inflRows.length) {
        const epCounts = new Map(res.epCounts);
        for (const [ep, n] of ri.epCounts) epCounts.set(ep, Math.max(epCounts.get(ep) ?? 0, n));
        const matched = [...epCounts.values()].reduce((s, n) => s + n, 0);
        res = {
          rows: [...res.rows, ...inflRows].slice(0, limit),
          matched,
          epCounts,
          inflected: matched - res.matched,
          inflKeys: new Set(inflRows.map(key))
        };
      }
    }
    if (res.matched) {
      let matchedExact = null;
      if (anyAccented(q)) {
        const w = ["msg_words MATCH ?", ...filt.where];
        matchedExact = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w.join(" AND ")}`).get(wordExpr(asTyped(q)), ...filt.params).n;
      }
      const pq = phraseQuery(q);
      if (sort === "recent") {
        const tiers = [];
        if (pq && matchedExact && q.clauses.flat(2).every(typedAccents)) tiers.push(wordExpr(pq, "exact"));
        if (pq) tiers.push(wordExpr(pq));
        if (matchedExact) tiers.push(wordExpr(asTyped(q)));
        if (tiers.length || inflRows.length) {
          const seen = /* @__PURE__ */ new Set();
          const out = [];
          const take = (rows, tier) => {
            for (const r of rows) {
              if (seen.has(key(r))) continue;
              seen.add(key(r));
              out.push({ ...r, tier });
            }
          };
          for (let i = 0; i < tiers.length && out.length < limit; i++)
            take(words(tiers[i], { ...opts, counts: false }).rows, i);
          take(exactRows, tiers.length);
          take(inflRows, tiers.length + 1);
          res.rows = out.slice(0, limit);
        }
        res.labelTier = matchedExact ? Math.max(0, tiers.length - 1) : tiers.length;
      } else if (pq) {
        const pr = words(wordExpr(pq), { ...opts, counts: false });
        if (pr.rows.length) {
          const seen = new Set(pr.rows.map(key));
          res.plainRows = res.rows;
          res.phraseRows = pr.rows;
          res.rows = [...pr.rows, ...res.rows.filter((r) => !seen.has(key(r)))].slice(0, limit);
        }
      }
      return { ...res, matchedExact, partial: false, path: "words" };
    }
    if (!partialFallback) return { ...none, path: "words" };
    const tri = trigram();
    return { ...tri, matchedExact: null, partial: tri.matched > 0, path: "trigram" };
  }
  const mixed = splitMixed(q);
  if (mixed) {
    const lw = likeWhere(mixed.rest);
    const res = runDocQuery(
      db,
      {
        from: "msg_words w CROSS JOIN docs d ON d.rowid = w.rowid",
        match: "msg_words",
        expr: wordExpr(mixed.words),
        where: lw.where,
        params: lw.params,
        rank: `bm25(msg_words, ${WORD_WEIGHTS.join(", ")})`
      },
      filt,
      opts
    );
    if (res.matched) return { ...res, matchedExact: null, partial: false, path: "mixed" };
  }
  return { ...trigram(), matchedExact: null, partial: false, path: q.clauses.length ? "trigram" : "filter" };
}
const EP_COLS = "id, chat_jid, sender, content, timestamp, is_from_me, media_type, quoted_id";
function episodeRows(episodeId) {
  return open().prepare(
    `SELECT ${EP_COLS} FROM docs WHERE episode_id = ? ORDER BY timestamp, rowid`
  ).all(episodeId);
}
function firstRow(episodeId) {
  return open().prepare(`SELECT ${EP_COLS} FROM docs WHERE episode_id = ? ORDER BY timestamp, rowid LIMIT 1`).get(episodeId);
}
function firstContentRow(episodeId) {
  return open().prepare(
    `SELECT ${EP_COLS} FROM docs WHERE episode_id = ? AND content IS NOT NULL AND TRIM(content) != ''
          ORDER BY timestamp, rowid LIMIT 1`
  ).get(episodeId) ?? firstRow(episodeId);
}
const LABEL_STOPWORDS = new Set(
  "a an the of to in on at for and or but nor is are was were be been being am about with by from as it its that this these those there here what who whom whose which when where why how do does did done has have had having his her hers him he she they them their theirs i me my mine you your yours we us our ours not no so if then than into over under after before up down out off very just also any some all each other own same such only both few more most can will would should could may might must s".split(" ")
);
function labelQuery(q) {
  const strip = (t) => {
    const n = term(t.text.replace(/['’]s\b/gi, ""), t);
    n.mode = "accentedExact";
    return n;
  };
  const content = (t) => tokens(fold(t.text)).some((x) => !LABEL_STOPWORDS.has(x));
  const clauses = q.clauses.map((c) => c.map((a) => a.map(strip).filter(content)).filter((a) => a.length)).filter((c) => c.length);
  return { clauses, negs: q.negs.map(strip).filter(content), items: [] };
}
const labelMinMatch = (n) => n <= 2 ? n : Math.max(2, Math.ceil(n / 2));
function searchHeaders(opts = {}) {
  return withScope(opts.chatJid ?? null, () => searchHeadersIn(opts));
}
function searchHeadersIn({
  query,
  parsed = null,
  chatJid = null,
  about = null,
  senders = null,
  after = null,
  before = null,
  limit = EPISODE_HEADER_MATCH_LIMIT,
  exclude = null
} = {}) {
  const q0 = parsed ?? parseQuery(query ?? "");
  if (!q0.clauses.length && !about) return { rows: [], ids: [] };
  const db = open();
  const where = [];
  const params = [];
  if (about) {
    const f = aboutFilter(db, chatJid, about);
    if (!f) return { rows: [], ids: [] };
    where.push(`e.id IN (${f.sql})`);
    params.push(...f.params);
  }
  const sc = scopeSql("e.chat_jid", chatJid);
  if (sc) {
    where.push(sc.sql);
    params.push(...sc.params);
  }
  if (senders?.length) {
    const bot = botRowSql("s");
    where.push(
      `EXISTS (SELECT 1 FROM docs s WHERE s.episode_id = e.id AND s.sender IN (${senders.map(() => "?").join(",")})${bot ? ` AND NOT ${bot}` : ""})`
    );
    params.push(...senders);
  }
  if (after) {
    where.push("e.ended_at >= ?");
    params.push(lowBound(after));
  }
  if (before) {
    where.push("e.started_at <= ?");
    params.push(highBound(before));
  }
  const meta = db.prepare("SELECT * FROM episodes WHERE id = ?");
  const finish = (ids2) => {
    const kept = ids2.filter((id) => !exclude?.has(id));
    return { rows: kept.slice(0, limit).map((id) => meta.get(id)).filter(Boolean), ids: kept };
  };
  const run = (from2, matchCol, expr, extraWhere = [], extraParams = [], order = "e.ended_at DESC") => {
    const w = [...expr ? [`${matchCol} MATCH ?`] : [], ...extraWhere, ...where];
    const p = [...expr ? [expr] : [], ...extraParams, ...params];
    return db.prepare(`SELECT e.id FROM ${from2} WHERE ${w.join(" AND ") || "1"} ORDER BY ${order}`).all(...p).map((r) => r.id);
  };
  if (!q0.clauses.length) return finish(run("episodes e", null, null, ["e.topic IS NOT NULL"]));
  if (!(wordIndexReady() && wordable(q0))) {
    const m = trigramMatch(q0, "ep_fts.header");
    return finish(
      run(
        "ep_fts CROSS JOIN episodes e ON e.id = ep_fts.rowid",
        "ep_fts",
        m.expr,
        m.where,
        m.params,
        m.expr ? "bm25(ep_fts), e.ended_at DESC" : "e.ended_at DESC"
      )
    );
  }
  const q = labelQuery(q0);
  if (!q.clauses.length) return { rows: [], ids: [] };
  const from = "ep_words CROSS JOIN episodes e ON e.id = ep_words.rowid";
  const hitsBy = /* @__PURE__ */ new Map();
  for (const c of q.clauses) {
    for (const id of run(from, "ep_words", clauseExpr(c, "both"))) hitsBy.set(id, (hitsBy.get(id) ?? 0) + 1);
  }
  const ranked = run(from, "ep_words", labelExpr(q), [], [], `bm25(ep_words, ${LABEL_WEIGHTS.join(", ")}), e.ended_at DESC`);
  const need = labelMinMatch(q.clauses.length);
  const ids = ranked.filter((id) => (hitsBy.get(id) ?? 0) >= need);
  ids.sort((a, b) => hitsBy.get(b) - hitsBy.get(a));
  const out = finish(ids);
  out.full = out.ids.filter((id) => hitsBy.get(id) === q.clauses.length).length;
  out.fieldRows = [];
  out.fieldIds = [];
  if (fieldsFuseWeight() > 0) {
    const ffrom = "ep_fwords CROSS JOIN episodes e ON e.id = ep_fwords.rowid";
    const fhits = /* @__PURE__ */ new Map();
    for (const c of q.clauses) {
      for (const id of run(ffrom, "ep_fwords", clauseExpr(c, "both"))) fhits.set(id, (fhits.get(id) ?? 0) + 1);
    }
    if (fhits.size) {
      const topicIds = new Set(ids);
      const franked = run(ffrom, "ep_fwords", labelExpr(q), [], [], `bm25(ep_fwords, ${LABEL_WEIGHTS.join(", ")}), e.ended_at DESC`);
      const fids = franked.filter((id) => (fhits.get(id) ?? 0) >= need && !topicIds.has(id) && !exclude?.has(id));
      fids.sort((a, b) => fhits.get(b) - fhits.get(a));
      out.fieldIds = fids;
      out.fieldRows = fids.slice(0, limit).map((id) => meta.get(id)).filter(Boolean);
      out.ids = [...out.ids, ...fids];
    }
  }
  return out;
}
function episodeIdsMatching({ chatJid = null, about = null, senders = null, after = null, before = null } = {}) {
  if (!about && !senders?.length && !after && !before) return null;
  return withScope(chatJid, () => {
    const db = open();
    const where = [];
    const params = [];
    if (about) {
      const f = aboutFilter(db, chatJid, about);
      if (!f) return /* @__PURE__ */ new Set();
      where.push(`e.id IN (${f.sql})`);
      params.push(...f.params);
    }
    const sc = scopeSql("e.chat_jid", chatJid);
    if (sc) {
      where.push(sc.sql);
      params.push(...sc.params);
    }
    if (senders?.length) {
      const bot = botRowSql("s");
      const ss = scopeSql("s.chat_jid", chatJid);
      where.push(
        `e.id IN (SELECT s.episode_id FROM docs s WHERE s.sender IN (${senders.map(() => "?").join(",")})${bot ? ` AND NOT ${bot}` : ""}${ss ? ` AND ${ss.sql}` : ""})`
      );
      params.push(...senders, ...ss ? ss.params : []);
    }
    if (after) {
      where.push("e.ended_at >= ?");
      params.push(lowBound(after));
    }
    if (before) {
      where.push("e.started_at <= ?");
      params.push(highBound(before));
    }
    return new Set(db.prepare(`SELECT e.id FROM episodes e WHERE ${where.join(" AND ")}`).pluck().all(...params));
  });
}
function fuseVectors(ranked, vector, { mode = "rrf", weight = 1, pin = 0, k = RRF_K, alpha = 0.5 } = {}) {
  if (!vector?.length) return ranked;
  const kw = ranked.map((r) => r.id);
  const byId = new Map(ranked.map((r) => [r.id, r]));
  const vinfo = new Map(vector.map((v, i) => [v.id, { rank: i + 1, cos: v.cos }]));
  const entry = (id, score) => ({
    id,
    score,
    ranks: byId.get(id)?.ranks ?? null,
    vecRank: vinfo.get(id)?.rank ?? null,
    cos: vinfo.get(id)?.cos ?? null
  });
  let order;
  if (mode === "weighted") {
    const hi = vector[0].cos;
    const lo = vector[vector.length - 1].cos;
    const kpos = new Map(kw.map((id, i) => [id, i]));
    const n = Math.max(kw.length, 1);
    order = [.../* @__PURE__ */ new Set([...kw, ...vector.map((v) => v.id)])].map((id) => {
      const r = kpos.get(id);
      const kws = r === void 0 ? 0 : 1 - r / n;
      const c = vinfo.get(id)?.cos;
      const cs = c !== void 0 && hi > lo ? (c - lo) / (hi - lo) : 0;
      return entry(id, alpha * cs + (1 - alpha) * kws);
    }).sort((a, b) => b.score - a.score);
  } else {
    order = fuse([{ ids: kw }, { ids: vector.map((v) => v.id), weight }], { k }).map((e) => entry(e.id, e.score));
  }
  const head = kw.slice(0, Math.max(0, pin));
  if (!head.length) return order;
  const pinned = new Set(head);
  const scoreOf = new Map(order.map((e) => [e.id, e.score]));
  return [...head.map((id) => entry(id, scoreOf.get(id) ?? 0)), ...order.filter((e) => !pinned.has(e.id))];
}
const VECTOR_TIER = 1e9;
const SHORT_LOOKUP_MEANING_MAX = 5;
function fuse(lists, { k = RRF_K } = {}) {
  const out = /* @__PURE__ */ new Map();
  lists.forEach(({ ids, weight = 1 }, li) => {
    ids.forEach((id, i) => {
      let e = out.get(id);
      if (!e) {
        e = { id, score: 0, ranks: lists.map(() => null) };
        out.set(id, e);
      }
      if (e.ranks[li] !== null) return;
      e.ranks[li] = i + 1;
      e.score += weight / (k + i + 1);
    });
  });
  return [...out.values()].sort((a, b) => b.score - a.score);
}
function searchEpisodes(opts) {
  const db = open();
  const q = opts.parsed ?? parseQuery(opts.query ?? "");
  const convLimit = Math.max(1, opts.limit ?? 20);
  const hits = searchIndex({ ...opts, parsed: q, limit: Math.max(SEARCH_HIT_POOL, convLimit) });
  const groups = /* @__PURE__ */ new Map();
  for (const h of hits.rows) {
    const key = h.episode_id ?? `loose:${h.chat_jid}:${h.id}`;
    if (!groups.has(key)) groups.set(key, { episode_id: h.episode_id, hits: [] });
    groups.get(key).hits.push(h);
  }
  const labels = searchHeaders({
    parsed: q,
    chatJid: opts.chatJid,
    about: opts.about,
    senders: opts.senders,
    after: opts.after,
    before: opts.before
  });
  const labelSet = new Set(labels.ids);
  const keyOf = (h) => h.episode_id ?? `loose:${h.chat_jid}:${h.id}`;
  const order = (rows) => [...new Set((rows ?? []).map(keyOf))];
  const inflKeys = hits.inflKeys ?? null;
  const isInfl = (r) => inflKeys?.has(`${r.chat_jid}:${r.id}`);
  const msgRows = hits.plainRows ?? hits.rows;
  const lists = [
    ...hits.phraseRows ? [{ ids: order(hits.phraseRows) }] : [],
    { ids: order(inflKeys ? msgRows.filter((r) => !isInfl(r)) : msgRows) },
    { ids: labels.rows.map((e) => e.id) },
    // Found only through the label fields: a list of its own, below a
    // message hit (FIELDS_FUSE_WEIGHT). Absent when nothing matched there,
    // so a search over a store without fields fuses exactly as before.
    ...labels.fieldRows?.length ? [{ ids: labels.fieldRows.map((e) => e.id), weight: fieldsFuseWeight() }] : []
  ];
  let ranked = fuse(lists);
  if (inflKeys) {
    const have = new Set(ranked.map((r) => r.id));
    const later = order(msgRows.filter(isInfl)).filter((id) => !have.has(id));
    ranked = [...ranked, ...later.map((id) => ({ id, score: 0, ranks: lists.map(() => null) }))];
  }
  let vector = opts.vector?.length ? opts.vector : null;
  let pinned = false;
  if (vector) {
    const vf = opts.vectorFusion ?? {};
    if (vf.delta != null) vector = vector.filter((v) => v.cos >= vector[0].cos - vf.delta);
    const kwTop = vf.kwTop === "all" ? ranked : ranked.slice(0, convLimit);
    const append = opts.sort === "recent" && (vf.recent ?? "append") === "append";
    const strong = hits.matched > 0 || labels.ids.length > 0 && (labelQuery(q).clauses.length <= 2 || (labels.full ?? 0) > 0);
    pinned = strong && (vf.pin ?? 0) > 0;
    ranked = fuseVectors(kwTop, vector, { ...vf, pin: append ? kwTop.length : strong ? vf.pin ?? 0 : 0 });
    const lookup = q.clauses.length === 1 && !q.negs?.length && !/\s/.test(fmtClause(q.clauses[0]).trim());
    const only = vf.only ?? (pinned && lookup ? SHORT_LOOKUP_MEANING_MAX : null);
    const kw = /* @__PURE__ */ new Set([...groups.keys(), ...labelSet]);
    if (only != null) {
      let n = 0;
      ranked = ranked.filter((r) => kw.has(r.id) || n++ < only);
    }
    if (vf.quota != null && strong && !append) {
      let n = 0;
      const keep = [];
      const later = [];
      for (const r of ranked) (kw.has(r.id) || n++ < vf.quota ? keep : later).push(r);
      ranked = [...keep, ...later];
    }
  }
  ranked = ranked.slice(0, convLimit);
  const meta = db.prepare("SELECT * FROM episodes WHERE id = ?");
  const labelRows = new Map([...labels.rows, ...labels.fieldRows ?? []].map((e) => [e.id, e]));
  const vecIds = new Set((vector ?? []).map((v) => v.id));
  let episodes = ranked.map(({ id, ranks, vecRank = null }) => {
    const g = groups.get(id);
    if (g && g.episode_id == null) {
      const h = g.hits[0];
      const { prev, next } = contextFor(h);
      const rows = [...prev, { ...h }, ...next];
      return {
        id: null,
        handle: null,
        chat_jid: h.chat_jid,
        started_at: rows[0].timestamp,
        ended_at: rows[rows.length - 1].timestamp,
        n_messages: rows.length,
        topic: null,
        about: null,
        register: null,
        hitCount: g.hits.length,
        hitIds: new Set(g.hits.map((x) => x.id)),
        hitOrder: g.hits.map((x) => x.id),
        best: h,
        labelMatch: false,
        tier: h.tier ?? 0,
        ranks,
        rows
      };
    }
    const vectorOnly = !g && !labelSet.has(id) && vecIds.has(id);
    const e0 = labelRows.get(id) ?? meta.get(id);
    if (vectorOnly && (!e0 || opts.chatJid && !inChatScope(opts.chatJid, e0.chat_jid))) return null;
    const e = e0 ?? {};
    return {
      id,
      handle: episodeHandle(id),
      chat_jid: e.chat_jid ?? g?.hits[0]?.chat_jid,
      started_at: e.started_at ?? g?.hits[0]?.timestamp,
      ended_at: e.ended_at ?? g?.hits[g.hits.length - 1]?.timestamp,
      n_messages: e.n_messages ?? 0,
      topic: e.topic ?? null,
      about: e.about ?? null,
      register: e.register ?? null,
      hitCount: g ? hits.epCounts.get(id) ?? g.hits.length : 0,
      hitIds: new Set((g?.hits ?? []).map((x) => x.id)),
      hitOrder: (g?.hits ?? []).map((x) => x.id),
      best: g?.hits[0] ?? null,
      labelMatch: labelSet.has(id),
      // Hits arrive in tier order (searchIndex, sort=recent), so the first
      // one carries the conversation's best tier.
      tier: vectorOnly ? VECTOR_TIER : g ? g.hits[0]?.tier ?? 0 : hits.labelTier ?? 0,
      ranks,
      ...vector ? { vectorOnly, vecRank } : {},
      rows: null
    };
  });
  if (vector) episodes = episodes.filter(Boolean);
  if (opts.sort === "recent")
    episodes = [...episodes].sort(
      (a, b) => a.tier - b.tier || String(b.ended_at).localeCompare(String(a.ended_at))
    );
  let msgConvs = 0;
  const msgEps = /* @__PURE__ */ new Set();
  for (const [ep, n] of hits.epCounts) {
    if (ep == null) msgConvs += n;
    else {
      msgConvs++;
      msgEps.add(ep);
    }
  }
  const labelOnly = labels.ids.filter((id) => !msgEps.has(id)).length;
  return {
    ...vector ? { vectorOnly: episodes.filter((e) => e.vectorOnly).length, vectorRanked: vector.length, pinned } : {},
    matched: hits.matched,
    matchedExact: hits.matchedExact,
    inflected: hits.inflected ?? 0,
    partial: hits.partial,
    path: hits.path,
    rows: hits.rows,
    episodes,
    msgConvs,
    labelConvs: labels.ids.length,
    labelOnly,
    totalConvs: msgConvs + labelOnly,
    query: q
  };
}
function matchOffset(content, q) {
  const text = String(content ?? "");
  if (!text || !q?.clauses?.length) return -1;
  const words = [];
  for (const m of text.matchAll(WORD_RE)) {
    for (const e of tokens(exact(m[0]))) words.push({ at: m.index, e, f: foldExact(e) });
  }
  const terms = q.clauses.flat(2).map((t) => {
    const e = tokens(exact(t.text, { teen: !t.prefix }));
    return { e, f: e.map(foldExact), prefix: t.prefix, accented: typedAccents(t) };
  }).filter((t) => t.e.length);
  const seq = (t, col) => t[col].map((tok, i) => ({ tok, prefix: t.prefix && i === t[col].length - 1 }));
  const find = (needle, col) => {
    outer: for (let i = 0; i + needle.length <= words.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        const w = words[i + j][col];
        const n = needle[j];
        if (n.prefix ? !w.startsWith(n.tok) : w !== n.tok) continue outer;
      }
      return words[i].at;
    }
    return -1;
  };
  const earliest = (list, col) => list.map((t) => find(seq(t, col), col)).filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
  if (words.length && terms.length) {
    if (terms.length > 1 && q.clauses.every((c) => c.length === 1 && c[0].length === 1)) {
      for (const col of ["e", "f"]) {
        const i = find(terms.flatMap((t) => seq(t, col)), col);
        if (i >= 0) return i;
      }
    }
    const ex = earliest(terms.filter((t) => t.accented), "e");
    if (ex !== Infinity) return ex;
    const any = earliest(terms, "f");
    if (any !== Infinity) return any;
    const infl = q.clauses.flat(2).map((t) => t.quoted || t.prefix ? null : wordForms(exact(t.text, { teen: false }))).filter(Boolean);
    const at = infl.length ? words.find((w) => infl.some((x) => x.forms.includes(w.f) || x.prefixes.some((p) => w.f.startsWith(p)))) : null;
    if (at) return at.at;
  }
  const low = text.normalize("NFC").toLowerCase();
  for (const t of q.clauses.flat(2)) {
    const i = low.indexOf(t.text.normalize("NFC").toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}
function trimParts(episode, pad, focus = episode.hitIds) {
  const { rows } = episode;
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (!focus.has(r.id)) return;
    for (let j = Math.max(0, i - pad); j <= Math.min(rows.length - 1, i + pad); j++)
      keep[j] = true;
  });
  const parts = [];
  let run = [];
  let gap = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (gap) {
        parts.push({ gap });
        gap = 0;
      }
      run.push(rows[i]);
    } else {
      if (run.length) {
        parts.push({ rows: run });
        run = [];
      }
      gap++;
    }
  }
  if (run.length) parts.push({ rows: run });
  if (gap) parts.push({ gap });
  return parts;
}
function packEpisodes(episodes, {
  budget = EPISODE_TOKEN_BUDGET - EPISODE_NOTE_RESERVE,
  blockBudget = EPISODE_BLOCK_BUDGET,
  maxBlocks = EPISODE_MAX_BLOCKS,
  fullCandidates = EPISODE_FULL_CANDIDATES,
  maxLines = EPISODE_LIST_MAX,
  renderBlock,
  renderLine = null,
  levels = EPISODE_TRIM_LEVELS,
  // (ep) -> false keeps a conversation out of the full blocks (a list line
  // only); the full-block candidates are then the first `fullCandidates`
  // that may be blocks. null = every conversation may be one.
  blockable = null
} = {}) {
  const blocks = [];
  const lines = [];
  let used = 0;
  let blockUsed = 0;
  let omitted = 0;
  let cand = 0;
  episodes.forEach((ep, i0) => {
    const eligible = !blockable || blockable(ep);
    const i = eligible ? cand++ : Infinity;
    if (blocks.length < maxBlocks && i < fullCandidates) {
      if (!ep.rows) ep.rows = ep.id != null ? episodeRows(ep.id) : [];
      const useLevels = ep.hitIds?.size ? levels : [null];
      for (const pad of useLevels) {
        if (!ep.rows.length) break;
        const parts = pad === null ? [{ rows: ep.rows }] : pad === "top" ? trimParts(ep, 1, new Set((ep.hitOrder ?? [...ep.hitIds]).slice(0, TOP_HITS))) : trimParts(ep, pad);
        const text2 = renderBlock(ep, parts, pad !== null);
        const tokens3 = estimateTokens(text2);
        const force = i === 0 && !blocks.length && ep.hitIds?.size && pad === useLevels[useLevels.length - 1];
        if (blockUsed + tokens3 <= blockBudget && used + tokens3 <= budget || force) {
          blocks.push({ episode: ep, text: text2, tokens: tokens3, trimmed: pad !== null });
          used += tokens3;
          blockUsed += tokens3;
          return;
        }
      }
    }
    if (!renderLine || lines.length >= maxLines) {
      omitted++;
      return;
    }
    const text = renderLine(ep);
    const tokens2 = estimateTokens(text);
    if (used + tokens2 > budget) {
      omitted++;
      return;
    }
    lines.push({ episode: ep, text, tokens: tokens2 });
    used += tokens2;
  });
  return { blocks, lines, tokens: used, omitted };
}
function episodeContext(handle, before = 0, after = 0) {
  const db = open();
  const id = parseEpisodeHandle(handle);
  if (id === null) return null;
  const episode = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id);
  if (!episode) return null;
  const pad = (op, order, ts, n) => n > 0 ? db.prepare(
    `SELECT ${EP_COLS} FROM docs WHERE chat_jid = ? AND timestamp ${op} ?
             ORDER BY timestamp ${order} LIMIT ?`
  ).all(episode.chat_jid, ts, n) : [];
  return {
    episode,
    handle: episodeHandle(id),
    before: pad("<", "DESC", episode.started_at, before).reverse(),
    rows: episodeRows(id),
    after: pad(">", "ASC", episode.ended_at, after)
  };
}
function contextFor(row, before = 2, after = 2) {
  const db = open();
  const prev = db.prepare(
    `SELECT id, sender, content, timestamp, is_from_me, media_type, quoted_id FROM docs
       WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`
  ).all(row.chat_jid, row.timestamp, before).reverse();
  const next = db.prepare(
    `SELECT id, sender, content, timestamp, is_from_me, media_type, quoted_id FROM docs
       WHERE chat_jid = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?`
  ).all(row.chat_jid, row.timestamp, after);
  return { prev, next };
}
export {
  EPISODE_BLOCK_BUDGET,
  EPISODE_FULL_CANDIDATES,
  EPISODE_GAP_MINUTES,
  EPISODE_HEADER_MATCH_LIMIT,
  EPISODE_LIST_MAX,
  EPISODE_MAX_BLOCKS,
  EPISODE_MAX_MESSAGES,
  EPISODE_NOTE_RESERVE,
  EPISODE_TOKEN_BUDGET,
  EPISODE_TRIM_LEVELS,
  FACTS_LINE_CHARS,
  FACTS_SHOW,
  FACT_SHOW_CHARS,
  FIELDS_FUSE_WEIGHT,
  INFLECT_MIN_PREFIX,
  LABEL_WEIGHTS,
  RELAX_MIN_MATCHES,
  RRF_K,
  SEARCH_HIT_POOL,
  SHORT_LOOKUP_MEANING_MAX,
  SYNC_LOOKBACK,
  TEEN_MIN_DOCS,
  TEEN_VI_SHARE,
  WORD_WEIGHTS,
  anyWordQuery,
  assignEpisodes,
  buildWordIndex,
  chatScope,
  checkEpisodeFields,
  clearEpisodeLabels,
  closeBatch,
  configureSearch,
  contextFor,
  count,
  episodeContext,
  episodeCount,
  episodeFields,
  episodeHandle,
  episodeIdsMatching,
  episodeRows,
  factsLine,
  fieldStats,
  fieldlessEpisodes,
  fieldsFuseWeight,
  firstContentRow,
  firstRow,
  formatQuery,
  fuse,
  fuseVectors,
  getEpisode,
  hasChat,
  headerLine,
  highBound,
  inChatScope,
  indexDb,
  indexStamp,
  indexWords,
  labelStats,
  lowBound,
  markSkipped,
  matchOffset,
  openBatches,
  orGroups,
  packEpisodes,
  parseEpisodeHandle,
  parseQuery,
  rebuildEpisodes,
  recentLabels,
  recordBatch,
  refreshDocs,
  relaxQuery,
  saveEpisodeFields,
  saveEpisodeLabel,
  saveLabelResult,
  searchEpisodes,
  searchHeaders,
  searchIndex,
  secretReason,
  sync,
  termFrequencies,
  unlabeledEpisodes,
  wordForms,
  wordIndexReady,
  wordIndexStats
};
