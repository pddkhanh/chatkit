// chatkit search engine — render.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import * as db from "./db.js";
import { sentMessage } from "./sentlog.js";
import { mentionNames } from "./searchplatform.js";
import { episodeRenderers } from "./searchrender.js";
const PROMPT_TAGS = [
  "memory",
  "untrusted_web_content",
  "untrusted_chat_history",
  "untrusted_quoted_message",
  "untrusted_image",
  "untrusted_voice_note",
  "untrusted_document"
];
const TAG_RE = new RegExp(`<(/?)\\s*(${PROMPT_TAGS.join("|")})\\b`, "gi");
function defuseTags(text) {
  return String(text ?? "").replace(TAG_RE, (_, slash, name) => `‹${slash}${name}`);
}
function quoteMap(rows) {
  const byChat = /* @__PURE__ */ new Map();
  for (const m of rows) {
    if (!m.quoted_id || !m.chat_jid) continue;
    if (!byChat.has(m.chat_jid)) byChat.set(m.chat_jid, []);
    byChat.get(m.chat_jid).push(m.quoted_id);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [jid, ids] of byChat) {
    try {
      for (const [id, row] of db.quotedPreviews(jid, ids)) out.set(id, row);
    } catch {
    }
  }
  return out;
}
function revisionMap(rows) {
  const byChat = /* @__PURE__ */ new Map();
  for (const m of rows) {
    if (!m.chat_jid) continue;
    if (!byChat.has(m.chat_jid)) byChat.set(m.chat_jid, []);
    byChat.get(m.chat_jid).push(m.id);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [jid, ids] of byChat) {
    try {
      for (const [id, row] of db.revisionsOf(jid, ids)) out.set(id, row);
    } catch {
    }
  }
  return out;
}
function revisionNote(r) {
  if (!r) return "";
  const at = (t) => String(t).replace("T", " ").slice(5, 16);
  let note = "";
  if (r.edited_at) {
    note += ` ⟨edited ${at(r.edited_at)} → "${defuseTags(r.edited_content ?? "")}"⟩`;
  }
  if (r.deleted_at) {
    const by = r.deleted_by && r.deleted_by !== r.sender ? ` by ${defuseTags(db.displayName(r.deleted_by) ?? r.deleted_by)}` : "";
    note += ` ⟨deleted ${at(r.deleted_at)}${by}⟩`;
  }
  return note;
}
function snippet(m, max = 32) {
  const body = defuseTags(m.content || "").replace(/\s+/g, " ").trim();
  if (!body) return m.media_type ? `<${m.media_type}>` : "…";
  return body.length > max ? `${body.slice(0, max)}…` : body;
}
function ownSticker(m) {
  if (!m.is_from_me || m.content) return null;
  const sent = sentMessage(m.id);
  return sent ? { who: `${sent.bot} (bot)`, what: sent.text || `<${m.media_type}>` } : null;
}
const whoSent = (m) => ownSticker(m)?.who ?? (m.is_from_me ? "Me" : defuseTags(db.displayName(m.sender) ?? m.sender));
function fmtRows(rows, detailed = false, mark = null, { revisions = false, clip = null } = {}) {
  const quotes = quoteMap(rows);
  const revs = revisions ? revisionMap(rows) : /* @__PURE__ */ new Map();
  return rows.map((m) => {
    const isHit = Boolean(mark && mark(m));
    const hit = isHit ? ">>> " : "";
    const name = m.is_from_me ? null : db.displayName(m.sender);
    const own = ownSticker(m);
    const who = own?.who ?? (m.is_from_me ? "Me" : defuseTags(name ?? m.sender));
    const raw = detailed && name ? ` (${m.sender})` : "";
    const ts = detailed ? m.timestamp : m.timestamp.slice(0, 16);
    const chat = m.chat_name ? ` [${defuseTags(m.chat_name)}]` : "";
    const media = own ? ` ${own.what}` : m.media_type ? ` <${m.media_type}>` : "";
    const id = detailed ? ` (id:${m.id})` : "";
    let reply = "";
    if (m.quoted_id) {
      const q = quotes.get(m.quoted_id);
      const qWho = q ? q.is_from_me ? whoSent(q) : defuseTags(db.displayName(q.sender) ?? "") : "";
      reply = q ? ` ↩${qWho ? `${qWho}: ` : ""}"${snippet(q)}"` : " ↩(earlier message)";
    }
    const body = clip ? clip(m, isHit) : m.content;
    return `${hit}[${ts}]${chat} ${who}${raw}${reply}:${media} ${defuseTags(body)}${mentionNote(m.content)}${revisionNote(revs.get(m.id))}${id}`;
  }).join("\n");
}
const MENTION_RE = /@(\d{6,20})(?!\d)/g;
function mentionNote(content) {
  const text = String(content ?? "");
  if (!text.includes("@")) return "";
  const seen = /* @__PURE__ */ new Map();
  for (const m of text.matchAll(MENTION_RE)) {
    if (seen.has(m[1])) continue;
    const names = mentionNames(m[1]);
    if (names.length) seen.set(m[1], names[0]);
  }
  if (!seen.size) return "";
  return ` ⟨${[...seen].map(([num, name]) => `@${num} = ${defuseTags(name)}`).join(", ")}⟩`;
}
function chatTitle(jid) {
  let name = null;
  try {
    name = db.getChat(jid)?.name ?? null;
  } catch {
    name = null;
  }
  const dm = /^(\d+)@(lid|s\.whatsapp\.net)$/.exec(String(jid ?? ""));
  if (dm && (!name || /^\d+$/.test(name))) {
    const who = db.displayName(dm[1]);
    return who ? `DM with ${who}` : `DM ${dm[1]}`;
  }
  return name || jid;
}
function searchRender({ revisions = false, spansChats = false, chatIds = false } = {}) {
  const titles = /* @__PURE__ */ new Map();
  const chatName = (jid) => {
    if (!titles.has(jid)) titles.set(jid, chatIds ? `${chatTitle(jid)} | ${jid}` : chatTitle(jid));
    return titles.get(jid);
  };
  const tagged = (rows) => spansChats ? rows.map((m) => m.chat_jid ? { ...m, chat_name: chatName(m.chat_jid) } : m) : rows;
  const r = episodeRenderers({
    rows: (rows, { detailed, mark, clip }) => fmtRows(rows, detailed, mark, { revisions, clip }),
    who: whoSent,
    defuse: defuseTags,
    link: () => null,
    chatName
  });
  return {
    hitRows: (rows, detailed, clip) => fmtRows(tagged(rows), detailed, null, { revisions, clip }),
    block: (ep, parts, trimmed, detailed, clip, opts) => r.renderEpisodeBlock(ep, parts, trimmed, detailed, false, clip, opts),
    line: (ep, opts) => r.renderEpisodeLine(ep, { ...opts, links: false })
  };
}
export {
  chatTitle,
  defuseTags,
  fmtRows,
  ownSticker,
  searchRender,
  whoSent
};
