// chatkit search engine — render.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import * as db from "./db.js";
import { episodeRenderers, clipText, searchClip } from "./searchrender.js";
function defuseTags(text) {
  return String(text ?? "").replace(/<(\/?)([a-zA-Z][\w-]*)/g, "<$1​$2");
}
function jumpLink(chatJid, messageId) {
  const chat = String(chatJid ?? "");
  const id = String(messageId ?? "");
  if (!/^-100\d+$/.test(chat) || !/^\d+$/.test(id)) return null;
  return `https://t.me/c/${chat.slice(4)}/${id}`;
}
const linkSuffix = (m) => {
  const url = jumpLink(m.chat_jid, m.id);
  return url ? ` ↗${url}` : "";
};
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
function snippet(m, max = 32) {
  const body = defuseTags(m.content || "").replace(/\s+/g, " ").trim();
  if (!body) return m.media_type ? `<${m.media_type}>` : "…";
  return body.length > max ? `${body.slice(0, max)}…` : body;
}
function fmtRows(rows, detailed = false, mark = null, links = false, clip = null) {
  const quotes = quoteMap(rows);
  return rows.map((m) => {
    const isHit = Boolean(mark && mark(m));
    const hit = isHit ? ">>> " : "";
    const jump = links === true || links === "hits" && isHit ? linkSuffix(m) : "";
    const name = m.is_from_me ? null : db.displayName(m.sender);
    const who = m.is_from_me ? "Me" : defuseTags(name ?? m.sender);
    const raw = detailed && name ? ` (${m.sender})` : "";
    const ts = detailed ? m.timestamp : m.timestamp.slice(0, 16);
    const chat = m.chat_name ? ` [${defuseTags(m.chat_name)}]` : "";
    const media = m.media_type ? ` <${m.media_type}>` : "";
    const id = detailed ? ` (id:${m.id})` : "";
    let reply = "";
    if (m.quoted_id) {
      const q = quotes.get(m.quoted_id);
      const qWho = q ? q.is_from_me ? "Me" : defuseTags(db.displayName(q.sender) ?? "") : "";
      reply = q ? ` ↩${qWho ? `${qWho}: ` : ""}"${snippet(q)}"` : " ↩(earlier message)";
    }
    const body = clip ? clip(m, isHit) : m.content;
    return `${hit}[${ts}]${chat} ${who}${raw}${reply}:${media} ${defuseTags(body)}${id}${jump}`;
  }).join("\n");
}
const shared = episodeRenderers({
  rows: (rows, { detailed, mark, links, clip }) => fmtRows(rows, detailed, mark, links, clip),
  who: (m) => m.is_from_me ? "Me" : defuseTags(db.displayName(m.sender) ?? m.sender),
  defuse: defuseTags,
  link: jumpLink,
  chatName: (jid) => db.getChat(jid)?.name ?? null
});
const { renderEpisodeBlock, renderEpisodeLine } = shared;
export {
  clipText,
  defuseTags,
  fmtRows,
  jumpLink,
  renderEpisodeBlock,
  renderEpisodeLine,
  searchClip
};
