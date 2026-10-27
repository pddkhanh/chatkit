// chatkit search engine — embed.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as index from "./searchindex.js";
import * as platform from "./searchplatform.js";
import { fold, tokens as wordTokens } from "./textnorm.js";
import { peopleOf, personForSender } from "./people.js";
const daemonRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODEL = Object.freeze({
  // The alias the LaunchAgent serves the GGUF under (--alias). Contract, not
  // decoration: it is checked on every response.
  id: "qwen3-embedding-0.6b-q8_0",
  file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
  dims: 1024,
  eos: 151643,
  // <|endoftext|>, the pooled token
  maxTokens: 2e3,
  task: "Given a question, retrieve group-chat conversations (Vietnamese, English or Chinese) that answer it"
});
const RECIPE_VERSION = 2;
const RECIPE_COMPAT = [1];
const DEFAULT_URL = "http://127.0.0.1:47800";
const QUERY_TIMEOUT_MS = 400;
const QUERY_MAX_CHARS = 1e3;
const DOC_TIMEOUT_MS = 12e4;
const MSG_CHARS = 700;
const TEXT_CHARS = 12e3;
const OWNER_NAME = process.env.CHATKIT_OWNER_NAME || "Me";
let cfg = null;
function readConfigFile() {
  try {
    const p = process.env.CHATKIT_CONFIG ?? path.join(daemonRoot, "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).embeddings ?? {};
  } catch {
    return {};
  }
}
const OFF_RE = /^(off|none|false|0|)$/i;
function config() {
  if (cfg) return cfg;
  const file = readConfigFile();
  const raw = process.env.EMBED_URL ?? (file.url === null ? "off" : file.url) ?? DEFAULT_URL;
  cfg = {
    url: OFF_RE.test(String(raw)) ? null : String(raw).replace(/\/+$/, ""),
    // stderr by default: an MCP server's stdout is its protocol.
    log: (line) => console.error(line)
  };
  return cfg;
}
function configureEmbeddings(o = {}) {
  const c = config();
  if ("url" in o) c.url = o.url ? String(o.url).replace(/\/+$/, "") : null;
  if (typeof o.log === "function") c.log = o.log;
  return { url: c.url };
}
const embedUrl = () => config().url;
const log = (line) => config().log(`[vectors] ${line}`);
const FUSION_DEFAULTS = Object.freeze({
  mode: "rrf",
  weight: 1,
  top: 100,
  pin: 3,
  k: 60,
  alpha: 0.5,
  recent: "append",
  kwTop: "shown",
  only: null,
  delta: 0.1,
  blocks: "strong",
  quota: 7
});
function fusionConfig() {
  const e = process.env;
  const num = (v, d) => v !== void 0 && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
  return {
    mode: e.SEARCH_VEC_FUSION === "weighted" ? "weighted" : FUSION_DEFAULTS.mode,
    weight: num(e.SEARCH_VEC_WEIGHT, FUSION_DEFAULTS.weight),
    top: Math.max(1, Math.trunc(num(e.SEARCH_VEC_TOP, FUSION_DEFAULTS.top))),
    pin: Math.max(0, Math.trunc(num(e.SEARCH_VEC_PIN, FUSION_DEFAULTS.pin))),
    k: num(e.SEARCH_VEC_K, FUSION_DEFAULTS.k),
    alpha: num(e.SEARCH_VEC_ALPHA, FUSION_DEFAULTS.alpha),
    recent: e.SEARCH_VEC_RECENT === "fuse" ? "fuse" : FUSION_DEFAULTS.recent,
    kwTop: e.SEARCH_VEC_KWTOP === "all" ? "all" : "shown",
    blocks: ["words", "all", "strong"].includes(e.SEARCH_VEC_BLOCKS) ? e.SEARCH_VEC_BLOCKS : FUSION_DEFAULTS.blocks,
    only: e.SEARCH_VEC_ONLY !== void 0 && e.SEARCH_VEC_ONLY !== "" ? Math.max(0, Math.trunc(num(e.SEARCH_VEC_ONLY, 0))) : FUSION_DEFAULTS.only,
    delta: e.SEARCH_VEC_DELTA !== void 0 && e.SEARCH_VEC_DELTA !== "" ? num(e.SEARCH_VEC_DELTA, null) : FUSION_DEFAULTS.delta,
    quota: e.SEARCH_VEC_QUOTA === "off" ? null : e.SEARCH_VEC_QUOTA !== void 0 && e.SEARCH_VEC_QUOTA !== "" ? Math.max(0, Math.trunc(num(e.SEARCH_VEC_QUOTA, 0))) : FUSION_DEFAULTS.quota,
    off: OFF_RE.test(String(e.SEARCH_VEC ?? "on"))
  };
}
const srv = { downUntil: 0, failures: 0, down: false, reason: null, lastNote: 0 };
const BREAKER_BASE_MS = 5e3;
const BREAKER_MAX_MS = 5 * 60 * 1e3;
const NOTE_EVERY_MS = 10 * 60 * 1e3;
function markDown(reason) {
  srv.failures++;
  const wait = Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** (srv.failures - 1));
  srv.downUntil = Date.now() + wait;
  const now = Date.now();
  if (!srv.down || srv.reason !== reason || now - srv.lastNote > NOTE_EVERY_MS) {
    log(`${reason} — searching on keywords only; next try in ${Math.round(wait / 1e3)}s (${config().url})`);
    srv.lastNote = now;
  }
  srv.down = true;
  srv.reason = reason;
}
function markUp() {
  if (srv.down) log(`llama-server answering again (${MODEL.id}) — meaning search on`);
  srv.down = false;
  srv.reason = null;
  srv.failures = 0;
  srv.downUntil = 0;
}
const why = (e) => e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : e?.cause?.code ?? e?.code ?? String(e?.message ?? e).slice(0, 120);
async function call(pathname, body, timeoutMs) {
  const url = config().url;
  if (!url) throw new Error("meaning search is off (EMBED_URL)");
  const r = await fetch(url + pathname, {
    method: body === void 0 ? "GET" : "POST",
    headers: body === void 0 ? void 0 : { "Content-Type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(text);
}
function unit(v) {
  if (!Array.isArray(v) && !(v instanceof Float32Array)) return null;
  if (v.length !== MODEL.dims) return null;
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (!Number.isFinite(n) || n === 0) return null;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
const decode = (e) => {
  if (typeof e !== "string") return e;
  const b = Buffer.from(e, "base64");
  const n = Math.floor(b.byteLength / 4);
  return b.byteOffset % 4 === 0 ? new Float32Array(b.buffer, b.byteOffset, n) : new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4));
};
async function embedRaw(inputs, timeoutMs) {
  const j = await call("/v1/embeddings", { input: inputs, encoding_format: "base64" }, timeoutMs);
  if (j?.model && j.model !== MODEL.id) throw new Error(`server serves "${j.model}", not ${MODEL.id}`);
  const data = [...j?.data ?? []].sort((a, b) => a.index - b.index);
  if (data.length !== inputs.length) throw new Error(`asked for ${inputs.length} vectors, got ${data.length}`);
  return { vecs: data.map((d) => unit(decode(d.embedding))), tokens: j?.usage?.prompt_tokens ?? null };
}
async function health({ timeoutMs = 3e3 } = {}) {
  const url = config().url;
  if (!url) return { ok: false, url: null, error: "off (EMBED_URL)" };
  const t0 = performance.now();
  try {
    const j = await call("/v1/models", void 0, timeoutMs);
    const m = (j?.data ?? [])[0] ?? {};
    const ids = [m.id, ...m.aliases ?? []].filter(Boolean);
    const dims = m.meta?.n_embd ?? null;
    const ok = ids.includes(MODEL.id) && (dims === null || dims === MODEL.dims);
    return {
      ok,
      url,
      model: m.id ?? null,
      dims,
      ctx: m.meta?.n_ctx ?? null,
      bytes: m.meta?.size ?? null,
      ms: Math.round(performance.now() - t0),
      error: ok ? null : `serves ${JSON.stringify(ids)} (${dims} dims), want ${MODEL.id} (${MODEL.dims})`
    };
  } catch (e) {
    return { ok: false, url, error: why(e), ms: Math.round(performance.now() - t0) };
  }
}
const vectorQuery = (q) => {
  const plain = String(q ?? "").split(/\s+/).filter((w) => w && w !== "OR" && !/^-\S/.test(w)).map((w) => w.replace(/["*]/g, "")).filter(Boolean).join(" ");
  if (plain.length <= QUERY_MAX_CHARS) return plain;
  const sp = plain.lastIndexOf(" ", QUERY_MAX_CHARS);
  let n = sp > QUERY_MAX_CHARS / 2 ? sp : QUERY_MAX_CHARS;
  const c = plain.charCodeAt(n - 1);
  if (c >= 55296 && c <= 56319) n--;
  return plain.slice(0, n);
};
const queryText = (q) => `Instruct: ${MODEL.task}
Query:${vectorQuery(q)}`.toWellFormed();
const qcache = /* @__PURE__ */ new Map();
const QCACHE_MAX = 256;
const lastQuery = { ms: null, cached: false, error: null };
async function queryVector(query, { timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  lastQuery.ms = null;
  lastQuery.cached = false;
  lastQuery.error = null;
  if (!config().url || fusionConfig().off) return null;
  const plain = vectorQuery(query);
  if (!plain) return null;
  const key = queryText(query);
  const hit = qcache.get(key);
  if (hit) {
    qcache.delete(key);
    qcache.set(key, hit);
    lastQuery.cached = true;
    return hit;
  }
  if (Date.now() < srv.downUntil) {
    lastQuery.error = `breaker open (${srv.reason})`;
    return null;
  }
  const t0 = performance.now();
  try {
    const { vecs } = await embedRaw([key], timeoutMs);
    if (!vecs[0]) throw new Error("no usable vector (NaN or wrong size)");
    markUp();
    lastQuery.ms = Math.round(performance.now() - t0);
    qcache.set(key, vecs[0]);
    if (qcache.size > QCACHE_MAX) qcache.delete(qcache.keys().next().value);
    return vecs[0];
  } catch (e) {
    lastQuery.error = why(e);
    if (e?.status) return null;
    markDown(`query embedding failed: ${lastQuery.error}`);
    return null;
  }
}
const FILLER = new Set(
  "ok oke okie okay okela uhm um uh hm hmm ua u ui uoi ah a oh o ha haha hahaha hihi hehe kk kkk kaka keke lol yes yup yeah ya ye no nope dạ da vang ừ ua ờ o ừa uay uh oi ôi trời troi vãi vai ghê ghe đù du the thế z vậy vay r rồi roi thôi thoi ạ nha nhé nhe hả ha hử ủa ua á à ơ ê e hix huhu xD".split(" ").map((w) => fold(w))
);
const URL_RE = /https?:\/\/\S+/g;
const bodyOf = (r) => (platform.docText ? platform.docText(r) : r.content) ?? "";
function contentWords(rows) {
  let n = 0;
  for (const r of rows) {
    const t = String(bodyOf(r) ?? "").replace(URL_RE, " ");
    for (const w of wordTokens(fold(t))) {
      if (w.length < 2 || FILLER.has(w) || /^(.)\1+$/.test(w) || /^(ha|he|hi|ke|ka)+$/.test(w)) continue;
      n++;
    }
  }
  return n;
}
const clip = (s, n) => {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 55296 && c <= 56319 ? n - 1 : n) + "…";
};
function nameOf(row, chatJid, names) {
  const key = `${chatJid}\0${row.is_from_me ? 1 : 0}\0${row.sender}`;
  const bot = platform.botName?.(row) ?? null;
  if (bot) return bot;
  if (names.has(key)) return names.get(key);
  let n = personForSender(chatJid, row.sender)?.name ?? null;
  if (!n && row.is_from_me) n = OWNER_NAME;
  if (!n) {
    try {
      n = platform.contactName?.(row.sender) ?? null;
    } catch {
      n = null;
    }
  }
  n = n || String(row.sender ?? "");
  names.set(key, n);
  return n;
}
function participantLabel(name, chatJid) {
  const p = peopleOf(chatJid).find((x) => x.name === name);
  const alt = p?.aliases?.find((a) => /[^\x00-\x7f]/.test(a) && a !== name);
  return alt ? `${name} (${alt})` : name;
}
function chatLabel(chatJid) {
  try {
    return platform.chatName?.(chatJid) || chatJid;
  } catch {
    return chatJid;
  }
}
const chatTitle = (chatJid) => chatLabel(chatJid);
function episodeText(ep, rows, names = /* @__PURE__ */ new Map()) {
  const people = [...new Set(rows.map((r) => nameOf(r, ep.chat_jid, names)))];
  const head = [
    `Chat: ${chatLabel(ep.chat_jid)}`,
    `Date: ${String(ep.started_at).slice(0, 16)} (${rows.length} message${rows.length === 1 ? "" : "s"})`,
    `Participants: ${people.map((n) => participantLabel(n, ep.chat_jid)).join(", ")}`
  ];
  if (ep.topic) head.push(`Label: ${[ep.register, ep.about ? `about ${ep.about}` : null, ep.topic].filter(Boolean).join(" · ")}`);
  const kw = (ep.fields?.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (kw.length) head.push(`Keywords: ${kw.join(", ")}`);
  const facts = (ep.fields?.facts ?? []).map((f) => String(f?.text ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (facts.length) head.push(`Facts: ${facts.map((f) => /[.!?]$/.test(f) ? f : `${f}.`).join(" ")}`);
  const lines = rows.map((r) => {
    const body = String(bodyOf(r) ?? "").trim();
    const text = body ? clip(body.replace(/\s*\n\s*/g, " / "), MSG_CHARS) : r.media_type ? `<${r.media_type}>` : "<empty>";
    return `${nameOf(r, ep.chat_jid, names)}: ${text}`;
  });
  return clip([...head, ...lines].join("\n"), TEXT_CHARS).toWellFormed();
}
const textHash = (text, recipe = RECIPE_VERSION) => crypto.createHash("sha1").update(`r${recipe}
${text}`).digest("hex").slice(0, 20);
const fieldsOf = (e) => {
  if (e.f_status !== "ok") return void 0;
  const arr = (s) => {
    try {
      const v = JSON.parse(s ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return { keywords: arr(e.f_keywords), facts: arr(e.f_facts) };
};
function quantize(v) {
  let mx = 0;
  for (let i = 0; i < v.length; i++) mx = Math.max(mx, Math.abs(v[i]));
  const scale = mx / 127;
  const q = new Int8Array(v.length);
  if (scale > 0) for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { scale, buf: Buffer.from(q.buffer) };
}
function storedVector(episodeId) {
  const r = index.indexDb().prepare("SELECT model, scale, vec FROM ep_vecs WHERE episode_id = ?").get(episodeId);
  if (!r?.vec) return null;
  const q = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * r.scale;
  return { model: r.model, vec: out };
}
function writeRows(items) {
  if (!items.length) return 0;
  const db = index.indexDb();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO ep_vecs
       (episode_id, chat_jid, model, recipe, hash, n_messages, labeled_at, fields_at, tokens, scale, vec, seq, embedded_at)
     SELECT @id, e.chat_jid, @model, @recipe, @hash, e.n_messages, e.labeled_at, f.written_at, @tokens, @scale, @vec, @seq, @at
       FROM episodes e LEFT JOIN ep_fields f ON f.episode_id = e.id
      WHERE e.id = @id AND e.n_messages = @n AND IFNULL(e.labeled_at, '') = IFNULL(@labeled_at, '')
        AND IFNULL(f.written_at, '') = IFNULL(@fields_at, '')`
  );
  const at = (/* @__PURE__ */ new Date()).toISOString();
  return db.transaction(() => {
    let seq = db.prepare("SELECT IFNULL(MAX(seq), 0) AS s FROM ep_vecs").get().s;
    let n = 0;
    for (const it of items) {
      const q = it.vec ? quantize(it.vec) : null;
      n += ins.run({
        id: it.id,
        model: MODEL.id,
        recipe: RECIPE_VERSION,
        hash: it.hash,
        n: it.n_messages,
        labeled_at: it.labeled_at ?? null,
        fields_at: it.fields_at ?? null,
        tokens: it.tokens ?? null,
        scale: q ? q.scale : null,
        vec: q ? q.buf : null,
        seq: ++seq,
        at
      }).changes;
    }
    return n;
  }).immediate();
}
function touchRows(items) {
  if (!items.length) return 0;
  const db = index.indexDb();
  const up = db.prepare(
    `UPDATE ep_vecs SET n_messages = @n, labeled_at = @labeled_at, fields_at = @fields_at, recipe = @recipe, hash = @hash
      WHERE episode_id = @id AND model = @model
        AND EXISTS (SELECT 1 FROM episodes e LEFT JOIN ep_fields f ON f.episode_id = e.id
                     WHERE e.id = @id AND e.n_messages = @n AND IFNULL(f.written_at, '') = IFNULL(@fields_at, ''))`
  );
  return db.transaction(
    () => items.reduce(
      (s, it) => s + up.run({
        id: it.id,
        n: it.n_messages,
        labeled_at: it.labeled_at ?? null,
        fields_at: it.fields_at ?? null,
        recipe: RECIPE_VERSION,
        hash: it.hash,
        model: MODEL.id
      }).changes,
      0
    )
  ).immediate();
}
function candidates({ chats = null, limit = 256, recentDays = null, settleMinutes = index.EPISODE_GAP_MINUTES, newest = true, count = false }) {
  const db = index.indexDb();
  const where = [
    "julianday(e.ended_at) <= julianday('now', @settle)",
    `(v.episode_id IS NULL OR v.model != @model OR v.recipe != @recipe
      OR v.n_messages != e.n_messages OR IFNULL(v.labeled_at, '') != IFNULL(e.labeled_at, '')
      OR IFNULL(v.fields_at, '') != IFNULL(f.written_at, ''))`
  ];
  const params = { settle: `-${Number(settleMinutes)} minutes`, model: MODEL.id, recipe: RECIPE_VERSION, limit };
  if (chats?.length) {
    where.push("e.chat_jid IN (SELECT value FROM json_each(@chats))");
    params.chats = JSON.stringify(chats);
  }
  if (recentDays != null) {
    where.push(
      "(v.episode_id IS NOT NULL OR julianday(e.ended_at) >= julianday('now', @recent) OR IFNULL(e.labeled_at, '') >= @recentIso)"
    );
    params.recent = `-${Number(recentDays)} days`;
    params.recentIso = new Date(Date.now() - recentDays * 864e5).toISOString();
  }
  const from = "episodes e LEFT JOIN ep_vecs v ON v.episode_id = e.id LEFT JOIN ep_fields f ON f.episode_id = e.id";
  if (count) {
    delete params.limit;
    return db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where.join(" AND ")}`).get(params).n;
  }
  return db.prepare(
    `SELECT e.id, e.chat_jid, e.started_at, e.ended_at, e.n_messages, e.topic, e.about, e.register, e.labeled_at,
              v.hash AS vhash, v.model AS vmodel, v.recipe AS vrecipe,
              f.status AS f_status, f.keywords AS f_keywords, f.facts AS f_facts, f.written_at AS fields_at
         FROM ${from}
        WHERE ${where.join(" AND ")}
        ORDER BY e.ended_at ${newest ? "DESC" : "ASC"}, e.id
        LIMIT @limit`
  ).all(params);
}
function pendingCount({ chats = null, recentDays = null, settleMinutes = index.EPISODE_GAP_MINUTES } = {}) {
  return candidates({ chats, recentDays, settleMinutes, count: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function prepare(eps, { timeoutMs }) {
  const names = /* @__PURE__ */ new Map();
  const filler = [];
  const same = [];
  const todo = [];
  for (const e of eps) {
    const rows = index.episodeRows(e.id);
    if (!rows.length) continue;
    const text = episodeText({ ...e, fields: fieldsOf(e) }, rows, names);
    const hash = textHash(text);
    const base = { id: e.id, chat_jid: e.chat_jid, n_messages: e.n_messages, labeled_at: e.labeled_at, fields_at: e.fields_at ?? null, hash };
    const sameText = e.vmodel === MODEL.id && (e.vrecipe === RECIPE_VERSION && e.vhash === hash || RECIPE_COMPAT.includes(e.vrecipe) && e.vhash === textHash(text, e.vrecipe));
    if (sameText) same.push(base);
    else if (contentWords(rows) < 3) filler.push({ ...base, vec: null, tokens: null });
    else todo.push({ ...base, text, bytes: Buffer.byteLength(text) });
  }
  let truncated = 0;
  for (const it of todo) {
    if (it.bytes < MODEL.maxTokens) {
      it.input = it.text;
      it.est = Math.ceil(it.bytes / 3);
      continue;
    }
    let t;
    try {
      t = await call("/tokenize", { content: it.text, add_special: false }, timeoutMs);
    } catch (e) {
      if (!e?.status) throw e;
      log(`episode ${it.id} could not be tokenized (${why(e)}) — skipped until it changes`);
      it.failed = true;
      continue;
    }
    let ids = (t.tokens ?? []).map((x) => typeof x === "number" ? x : x.id);
    if (ids.length > MODEL.maxTokens - 1) {
      ids = ids.slice(0, MODEL.maxTokens - 1);
      truncated++;
    }
    it.input = [...ids, MODEL.eos];
    it.est = it.input.length;
  }
  const refused = todo.filter((x) => x.failed).map((x) => ({ ...x, vec: null, tokens: -1 }));
  return { filler, same, todo: todo.filter((x) => !x.failed), refused, truncated };
}
function batches(todo, budget) {
  const out = [];
  for (const kind of ["string", "ids"]) {
    const list = todo.filter((x) => typeof x.input === "string" === (kind === "string")).sort((a, b) => a.est - b.est);
    let cur = [];
    let tok = 0;
    for (const it of list) {
      if (cur.length && tok + it.est > budget) {
        out.push(cur);
        cur = [];
        tok = 0;
      }
      cur.push(it);
      tok += it.est;
    }
    if (cur.length) out.push(cur);
  }
  return out;
}
async function embedPending({
  chats = null,
  limit = 256,
  recentDays = null,
  settleMinutes = index.EPISODE_GAP_MINUTES,
  batchTokens = 4096,
  maxTps = null,
  pauseMs = 0,
  timeoutMs = DOC_TIMEOUT_MS
} = {}) {
  const t0 = performance.now();
  const out = { picked: 0, embedded: 0, filler: 0, unchanged: 0, failed: 0, written: 0, tokens: 0, truncated: 0, ms: 0, error: null };
  if (!config().url) {
    out.error = "off (EMBED_URL)";
    return out;
  }
  const eps = candidates({ chats, limit, recentDays, settleMinutes });
  out.picked = eps.length;
  if (!eps.length) return out;
  let prep;
  try {
    prep = await prepare(eps, { timeoutMs });
  } catch (e) {
    out.error = `tokenize: ${why(e)}`;
    if (!e?.status) markDown(`document tokenize failed: ${why(e)}`);
    return out;
  }
  out.truncated = prep.truncated;
  out.unchanged = touchRows(prep.same);
  out.filler = prep.filler.length;
  out.failed = prep.refused.length;
  out.written += writeRows([...prep.filler, ...prep.refused]);
  const embedBatch = async (b) => {
    try {
      return await embedRaw(b.map((x) => x.input), timeoutMs);
    } catch (e) {
      if (!e?.status || b.length === 1) throw e;
      const vecs = [];
      let tokens = 0;
      for (const it of b) {
        try {
          const r = await embedRaw([it.input], timeoutMs);
          vecs.push(r.vecs[0]);
          tokens += r.tokens ?? it.est;
        } catch (e1) {
          if (!e1?.status) throw e1;
          log(`episode ${it.id} could not be embedded (${why(e1)}) — skipped until it changes`);
          it.failed = true;
          vecs.push(null);
        }
      }
      return { vecs, tokens };
    }
  };
  for (const b of batches(prep.todo, batchTokens)) {
    const s = performance.now();
    let res;
    try {
      res = await embedBatch(b);
    } catch (e) {
      out.error = why(e);
      if (!e?.status) markDown(`document embedding failed: ${out.error}`);
      else log(`document embedding failed: ${out.error}`);
      break;
    }
    markUp();
    const rows = [];
    b.forEach((it, i) => {
      if (res.vecs[i]) rows.push({ ...it, vec: res.vecs[i], tokens: typeof it.input === "string" ? null : it.input.length });
      else if (it.failed) rows.push({ ...it, vec: null, tokens: -1 });
    });
    out.written += writeRows(rows);
    out.embedded += rows.filter((r) => r.vec).length;
    out.failed += rows.filter((r) => !r.vec).length;
    const tok = res.tokens ?? b.reduce((x, it) => x + it.est, 0);
    out.tokens += tok;
    const spent = performance.now() - s;
    const floor = maxTps ? tok / maxTps * 1e3 : 0;
    const wait = Math.max(pauseMs, floor - spent);
    if (wait > 0) await sleep(wait);
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}
async function selfCheck({ timeoutMs = 1e4 } = {}) {
  const text = "Chat: check\nDate: 2026-10-14 12:00 (1 message)\nParticipants: Me\nMe: vợ Minh tên gì vậy";
  const t = await call("/tokenize", { content: text, add_special: false }, timeoutMs);
  const ids = (t.tokens ?? []).map((x) => typeof x === "number" ? x : x.id);
  const { vecs } = await embedRaw([text, [...ids, MODEL.eos], ids], timeoutMs);
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const same = dot(vecs[0], vecs[1]);
  const noEos = dot(vecs[0], vecs[2]);
  return { ok: same >= 0.9999 && noEos < 0.99, string_vs_ids: same, without_eos: noEos };
}
const MAINTAIN_TICK_MS = 2 * 60 * 1e3;
const MAINTAIN_PER_TICK = 64;
const MAINTAIN_RECENT_DAYS = 7;
let maintaining = false;
let maintainTimer = null;
async function maintainVectors({ perTick = MAINTAIN_PER_TICK, recentDays = MAINTAIN_RECENT_DAYS, sync = true } = {}) {
  if (maintaining || !config().url || Date.now() < srv.downUntil) return null;
  maintaining = true;
  try {
    if (sync) {
      try {
        index.sync();
      } catch (e) {
        log(`sync before embedding failed: ${e?.message ?? e}`);
      }
    }
    const r = await embedPending({ limit: perTick, recentDays, batchTokens: 1024 });
    if (r.embedded || r.filler || r.error)
      log(
        `embedded ${r.embedded} conversation${r.embedded === 1 ? "" : "s"}` + (r.filler ? `, ${r.filler} filler-only skipped` : "") + (r.unchanged ? `, ${r.unchanged} unchanged` : "") + ` in ${r.ms} ms${r.error ? ` — stopped: ${r.error}` : ""}`
      );
    return r;
  } catch (e) {
    log(`maintenance failed: ${e?.message ?? e}`);
    return null;
  } finally {
    maintaining = false;
  }
}
function startVectorMaintenance({ intervalMs = MAINTAIN_TICK_MS, log: logger = null, firstDelayMs = 3e4 } = {}) {
  if (logger) configureEmbeddings({ log: logger });
  if (maintainTimer || !config().url) return () => {
  };
  const first = setTimeout(() => maintainVectors(), firstDelayMs);
  first.unref?.();
  maintainTimer = setInterval(() => maintainVectors(), intervalMs);
  maintainTimer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(maintainTimer);
    maintainTimer = null;
  };
}
function kickVectorMaintenance(delayMs = 1e3) {
  if (!config().url) return;
  setTimeout(() => maintainVectors({ sync: false }), delayMs).unref?.();
}
const blocks = /* @__PURE__ */ new Map();
let globalStamp = null;
function loadChat(db, chatJid, stamp) {
  const max = db.prepare("SELECT COUNT(*) AS n FROM ep_vecs WHERE model = ? AND chat_jid = ? AND vec IS NOT NULL").get(MODEL.id, chatJid).n;
  const rows = db.prepare("SELECT episode_id, scale, vec FROM ep_vecs WHERE model = ? AND chat_jid = ? AND vec IS NOT NULL").iterate(MODEL.id, chatJid);
  const D = MODEL.dims;
  const ids = new Int32Array(max);
  const scales = new Float32Array(max);
  const vecs = new Int8Array(max * D);
  let n = 0;
  for (const r of rows) {
    if (n >= max) break;
    if (!r.vec || r.vec.byteLength !== D) continue;
    ids[n] = r.episode_id;
    scales[n] = r.scale;
    vecs.set(new Int8Array(r.vec.buffer, r.vec.byteOffset, D), n * D);
    n++;
  }
  const b = { stamp, n, ids: ids.subarray(0, n), scales: scales.subarray(0, n), vecs: vecs.subarray(0, n * D) };
  blocks.set(chatJid, b);
  return b;
}
function blocksFor(chatJid) {
  const db = index.indexDb();
  const scope = index.chatScope(chatJid);
  const stampOf = (r) => `${r.n}:${r.s}`;
  if (scope) {
    const rows2 = db.prepare(
      `SELECT chat_jid, COUNT(*) AS n, MAX(seq) AS s FROM ep_vecs
          WHERE model = ? AND chat_jid IN (${scope.map(() => "?").join(", ")}) GROUP BY chat_jid`
    ).all(MODEL.id, ...scope);
    const out = [];
    for (const r of rows2) {
      const have = blocks.get(r.chat_jid);
      out.push(have && have.stamp === stampOf(r) ? have : loadChat(db, r.chat_jid, stampOf(r)));
    }
    return out;
  }
  const g = db.prepare("SELECT COUNT(*) AS n, MAX(seq) AS s FROM ep_vecs WHERE model = ?").get(MODEL.id);
  if (globalStamp === stampOf(g)) return [...blocks.values()];
  const rows = db.prepare("SELECT chat_jid, COUNT(*) AS n, MAX(seq) AS s FROM ep_vecs WHERE model = ? GROUP BY chat_jid").all(MODEL.id);
  const live = /* @__PURE__ */ new Set();
  for (const r of rows) {
    live.add(r.chat_jid);
    const have = blocks.get(r.chat_jid);
    if (!have || have.stamp !== stampOf(r)) loadChat(db, r.chat_jid, stampOf(r));
  }
  for (const k of [...blocks.keys()]) if (!live.has(k)) blocks.delete(k);
  globalStamp = stampOf(g);
  return [...blocks.values()];
}
function vectorRank(qv, { chatJid = null, allow = null, top = FUSION_DEFAULTS.top } = {}) {
  const t0 = performance.now();
  if (!qv || qv.length !== MODEL.dims) return { ranked: [], scanned: 0, ms: 0 };
  const D = MODEL.dims;
  const K = Math.max(1, top);
  const topIds = new Int32Array(K);
  const topS = new Float64Array(K).fill(-Infinity);
  let cnt = 0;
  let min = -Infinity;
  let minAt = 0;
  let scanned = 0;
  for (const b of blocksFor(chatJid)) {
    const { ids, scales, vecs, n } = b;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      if (allow && !allow.has(id)) continue;
      scanned++;
      let s = 0;
      const o = i * D;
      for (let j = 0; j < D; j++) s += vecs[o + j] * qv[j];
      s *= scales[i];
      if (cnt < K) {
        topIds[cnt] = id;
        topS[cnt] = s;
        cnt++;
        if (cnt === K) {
          min = Infinity;
          for (let t = 0; t < K; t++) if (topS[t] < min) min = topS[t], minAt = t;
        }
      } else if (s > min) {
        topIds[minAt] = id;
        topS[minAt] = s;
        min = Infinity;
        for (let t = 0; t < K; t++) if (topS[t] < min) min = topS[t], minAt = t;
      }
    }
  }
  const ranked = [];
  for (let t = 0; t < cnt; t++) ranked.push({ id: topIds[t], cos: topS[t] });
  ranked.sort((a, b) => b.cos - a.cos || a.id - b.id);
  return { ranked, scanned, ms: Math.round((performance.now() - t0) * 10) / 10 };
}
function cacheInfo() {
  let n = 0;
  let bytes = 0;
  for (const b of blocks.values()) {
    n += b.n;
    bytes += b.vecs.byteLength + b.ids.byteLength + b.scales.byteLength;
  }
  return { chats: blocks.size, vectors: n, mb: Math.round(bytes / 2 ** 20 * 10) / 10 };
}
function clearVectorCache() {
  blocks.clear();
  globalStamp = null;
  qcache.clear();
}
function vectorStats({ chats = null } = {}) {
  const db = index.indexDb();
  const filt = chats?.length ? "WHERE e.chat_jid IN (SELECT value FROM json_each(?))" : "";
  const snap = "v.n_messages = e.n_messages AND IFNULL(v.labeled_at,'') = IFNULL(e.labeled_at,'') AND IFNULL(v.fields_at,'') = IFNULL(f.written_at,'')";
  const rows = db.prepare(
    `SELECT e.chat_jid,
              COUNT(*) AS episodes,
              SUM(v.episode_id IS NOT NULL AND v.model = ? AND v.recipe = ? AND v.vec IS NOT NULL AND ${snap}) AS embedded,
              SUM(v.episode_id IS NOT NULL AND v.model = ? AND v.recipe = ? AND v.vec IS NULL AND IFNULL(v.tokens, 0) != -1
                  AND ${snap}) AS filler,
              SUM(v.episode_id IS NOT NULL AND v.model = ? AND v.recipe = ? AND v.tokens = -1 AND ${snap}) AS failed,
              SUM(v.episode_id IS NOT NULL AND NOT (v.model = ? AND v.recipe = ? AND ${snap})) AS stale,
              SUM(v.episode_id IS NULL) AS missing
         FROM episodes e LEFT JOIN ep_vecs v ON v.episode_id = e.id LEFT JOIN ep_fields f ON f.episode_id = e.id
         ${filt}
        GROUP BY e.chat_jid ORDER BY episodes DESC`
  ).all(
    ...Array(4).fill([MODEL.id, RECIPE_VERSION]).flat(),
    ...chats?.length ? [JSON.stringify(chats)] : []
  );
  const total = { chats: rows.length, episodes: 0, embedded: 0, filler: 0, failed: 0, stale: 0, missing: 0 };
  for (const r of rows) for (const k of ["episodes", "embedded", "filler", "failed", "stale", "missing"]) total[k] += r[k] ?? 0;
  const other = db.prepare("SELECT COUNT(*) AS n FROM ep_vecs WHERE model != ?").get(MODEL.id).n;
  return { model: MODEL.id, recipe: RECIPE_VERSION, total, otherModelRows: other, chats: rows };
}
export {
  DEFAULT_URL,
  DOC_TIMEOUT_MS,
  FUSION_DEFAULTS,
  MAINTAIN_PER_TICK,
  MAINTAIN_RECENT_DAYS,
  MAINTAIN_TICK_MS,
  MODEL,
  QUERY_MAX_CHARS,
  QUERY_TIMEOUT_MS,
  RECIPE_COMPAT,
  RECIPE_VERSION,
  cacheInfo,
  chatTitle,
  clearVectorCache,
  configureEmbeddings,
  contentWords,
  embedPending,
  embedUrl,
  episodeText,
  fusionConfig,
  health,
  kickVectorMaintenance,
  lastQuery,
  maintainVectors,
  pendingCount,
  queryText,
  queryVector,
  selfCheck,
  startVectorMaintenance,
  storedVector,
  textHash,
  vectorQuery,
  vectorRank,
  vectorStats
};
