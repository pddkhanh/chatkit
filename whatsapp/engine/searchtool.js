// chatkit search engine — searchtool.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import * as index from "./searchindex.js";
import * as embed from "./embed.js";
import { exact, tokens, shortFormsOf } from "./textnorm.js";
import { searchClip } from "./searchrender.js";
const empty = (r) => !r || !r.rows?.length && !r.episodes?.some((e) => !e.vectorOnly);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MEANING_ONLY_MAX = 10;
const ECHO_MAX_CHARS = 160;
const ECHO_MAX_WORDS = 12;
function echo(s) {
  const cs = [...String(s ?? "")];
  if (cs.length <= ECHO_MAX_CHARS) return JSON.stringify(cs.join(""));
  return `${JSON.stringify(`${cs.slice(0, ECHO_MAX_CHARS).join("")}…`)} (${cs.length} characters)`;
}
const clipChars = (s) => {
  const cs = [...String(s ?? "")];
  return cs.length <= ECHO_MAX_CHARS ? cs.join("") : `${cs.slice(0, ECHO_MAX_CHARS).join("")}… (${cs.length} characters)`;
};
const clipList = (xs) => xs.length > ECHO_MAX_WORDS ? [...xs.slice(0, ECHO_MAX_WORDS), `… ${xs.length - ECHO_MAX_WORDS} more`] : xs;
async function searchMessages(args, ctx) {
  const { jid = null, senders = null, render } = ctx;
  const unlabelledNote = ctx.unlabelledNote ?? "";
  const openTool = ctx.openTool ?? "get_conversation";
  const info = ctx.info ?? {};
  info.queries = [];
  const detailed = Boolean(args.detailed);
  const limit = args.limit ?? 25;
  if (!args.query && !args.about && !args.sender && !args.after && !args.before) {
    return "give it something to filter on: query, about, sender, or after/before.";
  }
  const lines0 = !args.context;
  const fusion = embed.fusionConfig();
  let vector = null;
  if (args.query && ctx.vectors !== false && !fusion.off) {
    const qv = await embed.queryVector(args.query);
    if (qv) {
      const allow = index.episodeIdsMatching({
        chatJid: jid,
        senders,
        about: args.about ?? null,
        after: args.after ?? null,
        before: args.before ?? null
      });
      const r = embed.vectorRank(qv, { chatJid: jid, allow, top: fusion.top });
      vector = r.ranked.length ? r.ranked : null;
      info.vector = { ms: embed.lastQuery.ms, cached: embed.lastQuery.cached, scanMs: r.ms, scanned: r.scanned, ranked: r.ranked.length };
    } else info.vector = { error: embed.lastQuery.error };
  }
  const run = (parsed2, { partial = false, pin = fusion.pin } = {}) => {
    info.queries.push(index.formatQuery(parsed2));
    return index.searchEpisodes({
      parsed: parsed2,
      about: args.about ?? null,
      chatJid: jid,
      senders,
      partialFallback: partial,
      after: args.after ?? null,
      before: args.before ?? null,
      sort: args.sort ?? "relevance",
      vector,
      vectorFusion: { ...fusion, pin },
      // Conversations to rank. context:0 lists matching LINES (args.limit
      // of them, from the hit pool) and keeps label-only conversations as
      // list lines, so it ranks a fixed number.
      limit: lines0 ? 40 : Math.min(limit, index.EPISODE_LIST_MAX + index.EPISODE_MAX_BLOCKS)
    });
  };
  const parsed = index.parseQuery(args.query ?? "");
  let result = run(parsed);
  const notes = [];
  if (parsed.ignored.length)
    notes.push(`(ignored ${parsed.ignored.map((t) => `-${t}`).join(" ")}: it is also one of the search words)`);
  if (parsed.dropped.length) notes.push(`(ignored ${parsed.dropped.join(" ")}: no letters or digits to search for)`);
  if (!result.matched && args.query) {
    const groups = index.orGroups(parsed);
    if (groups) {
      const retry = run(groups);
      if (retry.matched) {
        result = retry;
        notes.push(
          `(nothing for ${echo(args.query)} with OR joining single words — read as whole alternatives: ${clipChars(index.formatQuery(groups))})`
        );
      }
    }
  }
  if (empty(result) && args.query) {
    const relaxed = index.relaxQuery(args.query, { chatJid: jid });
    if (relaxed) {
      const retry = run(index.parseQuery(relaxed.query), { pin: 0 });
      if (!empty(retry)) {
        result = retry;
        notes.push(`(no match for ${echo(args.query)} — showing results for ${echo(relaxed.query)})`);
      }
    }
  }
  if (empty(result) && args.query) {
    const any = index.anyWordQuery(parsed);
    if (any) {
      const retry = run(any, { pin: 0 });
      if (!empty(retry)) {
        result = retry;
        notes.push(
          `(nothing has all of ${echo(args.query)} — showing conversations with ANY of those words, most matches first)`
        );
      }
    }
  }
  if (empty(result) && args.query) {
    const retry = run(parsed, { partial: true, pin: 0 });
    if (!empty(retry) || retry.episodes?.length) result = retry;
  }
  if (empty(result) && !args.query) {
    return `nothing matches about=${JSON.stringify(args.about ?? "")}${args.sender ? ` from ${args.sender}` : ""}. about= is a SUBJECT filter — a person's name, or "the group"/"nobody"/"unclear" — not a topic search.` + (ctx.aboutMissNote ?? "");
  }
  const meaningOnly = empty(result) && Boolean(result?.episodes?.length);
  if (meaningOnly) result.episodes = result.episodes.slice(0, MEANING_ONLY_MAX);
  const wordHint = () => {
    const freq = index.termFrequencies(args.query, { chatJid: jid });
    const missing = freq.filter((f) => !f.df).map((f) => f.text);
    const present = freq.filter((f) => f.df);
    if (freq.length > 1 && !present.length) return " None of those words appears anywhere — try different words entirely.";
    if (freq.length > 1)
      return (missing.length ? ` Not present at all: ${clipList(missing).join(", ")}.` : "") + ` The rest never appear in one message together (counts: ${clipList(present.map((f) => `${f.text} ${f.df}`)).join(", ")}) — search the rarest ONE, use OR, or use sender=.`;
    return "";
  };
  if (empty(result) && !meaningOnly) {
    const hint = wordHint();
    return notes.join("\n") + (notes.length ? "\n" : "") + `no messages or conversation labels match ${echo(args.query)}.${hint}` + (args.about ? "" : unlabelledNote);
  }
  const clip = searchClip(result.query);
  if (result.partial)
    notes.push(
      "(no whole-word match — these are PARTIAL-word matches: the letters occur inside longer words, so check each one)"
    );
  const shorts = [
    ...new Set(result.query.clauses.flat(2).flatMap((t) => tokens(exact(t.text)).flatMap(shortFormsOf)))
  ];
  const exactNote = result.matchedExact != null && result.matchedExact !== result.matched ? ` (${result.matchedExact} with the accents as typed${shorts.length ? `, short forms ${shorts.slice(0, 5).join("/")} included` : ""})` : "";
  const formsNote = result.inflected ? ` (${result.inflected} only as another form of a word: -s, -ed, -ing …)` : "";
  const meaningN = meaningOnly ? result.episodes.length : result.vectorOnly ?? 0;
  const meaningNote = meaningN ? `; ${plural(meaningN, "more conversation")} close in meaning only (≈ — no shared words, check each)` : "";
  const found = meaningOnly ? `no message or label contains those words.${wordHint()} ${plural(meaningN, "conversation")} close in MEANING only (≈ — they share no words with the query and may be beside the point)` : (result.matched ? `${plural(result.matched, "message")} match${result.matched === 1 ? "es" : ""}${exactNote}${formsNote} in ${plural(result.msgConvs, "conversation")}` + (result.labelOnly ? `; ${plural(result.labelOnly, "more conversation")} match${result.labelOnly === 1 ? "es" : ""} only on the label` : "") : `no message contains it; ${plural(result.labelOnly, "conversation")} match${result.labelOnly === 1 ? "es" : ""} on the label`) + meaningNote;
  const showChat = !jid;
  if (lines0) {
    const rows = result.rows.slice(0, limit);
    const labelOnly = result.episodes.filter((e) => !e.best).slice(0, 10);
    const byMeaning = labelOnly.filter((e) => e.vectorOnly).length;
    const byLabel = labelOnly.length - byMeaning;
    const what = byMeaning ? [byLabel ? `${byLabel} label-only` : null, `${byMeaning} close-in-meaning`].filter(Boolean).join(" and ") + ` conversation${labelOnly.length === 1 ? "" : "s"}` : `${labelOnly.length} label-only conversation${labelOnly.length === 1 ? "" : "s"}`;
    const head2 = `(${found}. ` + (rows.length ? `Top ${plural(rows.length, "matching line")}` : "") + (labelOnly.length ? `${rows.length ? ", then " : ""}${what} — open one with ${openTool}` : "") + ")";
    const out2 = [...notes, head2];
    if (rows.length) out2.push(render.hitRows(rows, detailed, (m) => clip(m, true)));
    if (labelOnly.length)
      out2.push(labelOnly.map((e) => render.line(e, { query: result.query, detailed, showChat })).join("\n"));
    return out2.join("\n");
  }
  const wordsBlocks = meaningN && !meaningOnly && (fusion.blocks === "words" || fusion.blocks === "strong" && result.pinned);
  const { blocks, lines } = index.packEpisodes(result.episodes, {
    renderBlock: (ep, parts, trimmed) => render.block(ep, parts, trimmed, detailed, clip, { showChat }),
    renderLine: (ep) => render.line(ep, { query: result.query, detailed, showChat }),
    blockable: meaningOnly ? () => false : wordsBlocks ? (ep) => !ep.vectorOnly : null
  });
  if (meaningOnly) {
    const out2 = [
      ...notes,
      `(${found} — one line each, closest first; open one with ${openTool} if it looks right)`,
      lines.map((l) => l.text).join("\n")
    ];
    return out2.join("\n");
  }
  const shown = [...blocks, ...lines].filter((b) => !b.episode.vectorOnly).length;
  const rest = Math.max(0, result.totalConvs - shown);
  const head = `(${found}. Best first: ${blocks.length} in full` + (lines.length ? `, then ${lines.length} more one line each` : "") + ` — open any [conv:…] with ${openTool}` + (rest ? `. ${rest} more not shown: add a word, or narrow with sender/after/before/about` : "") + ")";
  const out = [...notes, head, blocks.map((b) => b.text).join("\n\n")];
  if (lines.length) out.push("", "More matching conversations:", lines.map((l) => l.text).join("\n"));
  return out.join("\n");
}
export {
  ECHO_MAX_CHARS,
  ECHO_MAX_WORDS,
  MEANING_ONLY_MAX,
  echo,
  searchMessages
};
