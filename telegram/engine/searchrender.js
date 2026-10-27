// chatkit search engine — searchrender.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import * as index from "./searchindex.js";
function clipText(text, max, at = -1) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  let start = 0;
  if (at > max / 3) {
    start = Math.min(at - Math.floor(max / 3), s.length - max);
    const sp = s.lastIndexOf(" ", start + 12);
    if (sp > start - 12 && sp > 0) start = sp + 1;
  }
  const end = Math.min(s.length, start + max);
  return `${start > 0 ? "…" : ""}${s.slice(start, end).trim()}${end < s.length ? "…" : ""}`;
}
function searchClip(query, { hit = 500, other = 300 } = {}) {
  return (m, isHit) => clipText(m.content, isHit ? hit : other, isHit ? index.matchOffset(m.content, query) : -1);
}
function episodeRenderers(adapter) {
  const defuse = adapter.defuse ?? ((s) => String(s ?? ""));
  const linkOf = (chatJid, id) => adapter.link?.(chatJid, id) ?? null;
  const linkSuffix = (m) => {
    const url = linkOf(m.chat_jid, m.id);
    return url ? ` ↗${url}` : "";
  };
  const chatLabel = (ep, showChat) => showChat ? defuse(adapter.chatName?.(ep.chat_jid) || ep.chat_jid) : null;
  function renderEpisodeBlock(ep, parts, trimmed, detailed, links = false, clip = null, { showChat = false } = {}) {
    const when = ep.started_at.slice(0, 10) + (ep.ended_at.slice(0, 10) !== ep.started_at.slice(0, 10) ? `→${ep.ended_at.slice(5, 10)}` : "");
    const first = parts.find((p) => p.rows?.length)?.rows[0];
    const jump = links && first ? linkOf(ep.chat_jid, first.id) : null;
    const head = [
      ep.handle ? `[${ep.handle}]` : "[conversation]",
      when,
      showChat ? `in ${chatLabel(ep, true)}` : null,
      `${ep.n_messages} msgs`,
      ep.hitCount ? `${ep.hitCount} match${ep.hitCount === 1 ? "" : "es"}` : ep.vectorOnly ? "≈ close in meaning" : "label match",
      jump ? `↗${jump}` : null
    ].filter(Boolean).join(" · ");
    const label = defuse(index.headerLine(ep));
    const fl = index.factsLine(ep);
    const facts = fl ? defuse(fl) : null;
    const body = parts.map(
      (p) => p.gap ? `  … ${p.gap} more message${p.gap === 1 ? "" : "s"} …` : adapter.rows(
        p.rows.map((m) => ({ ...m, chat_jid: ep.chat_jid })),
        {
          detailed,
          mark: (m) => ep.hitIds.has(m.id),
          // Only the matching lines inside a block, never all of them: a
          // 40-message episode with a link per row would cost more than
          // the messages it is showing.
          links: links ? "hits" : false,
          clip
        }
      )
    ).join("\n");
    return [`${head}${trimmed ? " · trimmed" : ""}`, label, facts, body].filter(Boolean).join("\n");
  }
  function renderEpisodeLine(ep, { query = null, max = 120, topicMax = 90, links = true, detailed = false, showChat = false } = {}) {
    const handle = ep.handle ? `[${ep.handle}]` : "[conversation]";
    const lead = showChat ? `${handle} (${chatLabel(ep, true)})` : handle;
    const topic = ep.topic && ep.topic.length > topicMax ? `${ep.topic.slice(0, topicMax).trim()}…` : ep.topic;
    const label = ep.topic ? defuse([ep.register, ep.about ? `about ${ep.about}` : null, topic].filter(Boolean).join(" · ")) : null;
    if (ep.best) {
      const m = { ...ep.best, chat_jid: ep.chat_jid };
      const who = adapter.who(m);
      const media = m.media_type ? ` <${m.media_type}>` : "";
      const flat = String(m.content ?? "").replace(/\s+/g, " ").trim();
      const body = defuse(clipText(flat, max, query ? index.matchOffset(flat, query) : -1));
      const id2 = detailed ? ` (id:${m.id})` : "";
      return `${lead} ${label ? `${label} | ` : ""}[${m.timestamp.slice(0, 16)}] ${who}:${media} ${body}${id2}${links ? linkSuffix(m) : ""}`;
    }
    const first = ep.id != null ? index.firstRow(ep.id) : null;
    const jump = links && first ? linkSuffix({ ...first, chat_jid: ep.chat_jid }) : "";
    const id = detailed && first ? ` (id:${first.id})` : "";
    if (ep.vectorOnly) {
      if (label) return `${lead} ${String(ep.started_at).slice(0, 10)} · ${ep.n_messages} msgs · ≈ ${label}${id}${jump}`;
      const rep = ep.id != null ? index.firstContentRow(ep.id) : null;
      if (rep) {
        const m = { ...rep, chat_jid: ep.chat_jid };
        const media = m.media_type ? ` <${m.media_type}>` : "";
        const flat = String(m.content ?? "").replace(/\s+/g, " ").trim();
        const rid = detailed ? ` (id:${m.id})` : "";
        return `${lead} ≈ ${ep.n_messages} msgs | [${m.timestamp.slice(0, 16)}] ${adapter.who(m)}:${media} ${defuse(clipText(flat, max))}${rid}${links ? linkSuffix(m) : ""}`;
      }
      return `${lead} ${String(ep.started_at).slice(0, 10)} · ${ep.n_messages} msgs · ≈ close in meaning${id}${jump}`;
    }
    return `${lead} ${String(ep.started_at).slice(0, 10)} · ${ep.n_messages} msgs · label match${label ? `: ${label}` : ""}${id}${jump}`;
  }
  return { renderEpisodeBlock, renderEpisodeLine };
}
export {
  clipText,
  episodeRenderers,
  searchClip
};
