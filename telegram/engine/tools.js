// chatkit — Telegram read tools for the MCP server. Read-only: nothing here sends.
import { z } from "zod";
import * as db from "./db.js";
import * as index from "./searchindex.js";
import { fmtRows, renderEpisodeBlock, renderEpisodeLine, defuseTags, jumpLink } from "./render.js";
import { searchMessages } from "./searchtool.js";
import { personSenders } from "./people.js";
const SEARCH_RENDER = {
  hitRows: (rows, detailed, clip) => fmtRows(rows, detailed, null, true, clip),
  block: (ep, parts, trimmed, detailed, clip, opts) => renderEpisodeBlock(ep, parts, trimmed, detailed, true, clip, opts),
  line: (ep, opts) => renderEpisodeLine(ep, opts)
};
function senderKeys(jid, name) {
  const configured = jid ? personSenders(jid, name) : null;
  if (configured) return configured;
  const keys = db.resolveSenderKeys(name);
  return keys.length ? keys : null;
}
const noSender = (name) => `no sender matches ${JSON.stringify(name)} (a display name, @username or id) — get_chat_members lists who talks in a chat.`;
function buildTools({ chatJid = null } = {}) {
  const scoped = chatJid !== null;
  const jidOf = (args) => scoped ? chatJid : args.chat_jid ?? null;
  const chatArg = scoped ? {} : { chat_jid: z.string().optional() };
  const tools = [];
  const add = (name, description, schema, handler) => tools.push({ name, description, schema, handler });
  add(
    "search_messages",
    "Search this chat's stored history. Returns CONVERSATIONS, best first: the top few in full (>>> marks the matching lines), then one line per further match with its [conv:xxx] handle, label and best line — open any of them with get_conversation." + (scoped ? "" : " Omit chat_jid to search ALL chats.") + `

Query: words must all appear in one message, any order. "quoted phrase" = exact run; a OR b = either (OR binds tighter than the spaces, so quote multi-word alternatives: "thôi nôi" OR "đầy tháng"); -word excludes; word* = prefix. Whole words only; accents and common teen code are ignored — dam cuoi finds đám cưới, ko finds không, vk finds vợ — and typing the accents ranks that spelling first (Hằng above hàng). If no whole word matches, partial-word matches are shown, marked as such.

query also matches the conversation LABELS, which are English (register · who it is about · topic, plus each conversation's people, keywords and facts — a '≡ facts:' line under the label), so English words work in a Vietnamese chat: 'flowers' finds the Valentine thread whose messages never contain the word. Conversations close in MEANING are added too, marked ≈ (a question in English finds a Vietnamese thread that shares no word with it) — check those; words typed as written still rank first.

about= keeps conversations ABOUT someone — any of their names works (nickname, display name, with or without a leading a/anh/ku), or 'the group' / 'nobody' / 'unclear'. A subject filter, not a topic search. sender= keeps one person's messages (same names); after/before take YYYY-MM-DD; sort=recent puts newest first; limit = how many conversations. context:0 returns matching lines instead (limit = how many). Only chats you ran chatkit label on have labels, so labels and about= are silent elsewhere.

Rows carry ↗https://t.me/… jump links: paste one verbatim when you cite an old message. Never build or edit one.`,
    {
      query: z.string().optional(),
      about: z.string().optional(),
      sender: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      sort: z.enum(["relevance", "recent"]).default("relevance"),
      context: z.number().int().min(0).max(5).default(2),
      limit: z.number().int().min(1).max(100).default(25),
      detailed: z.boolean().default(false),
      ...chatArg
    },
    (args) => {
      const jid = jidOf(args);
      if (!args.query && !args.about && !args.sender && !args.after && !args.before) {
        return "give it something to filter on: query, about, sender, or after/before.";
      }
      const senders = args.sender ? senderKeys(jid, args.sender) : null;
      if (args.sender && !senders) return noSender(args.sender);
      return searchMessages(args, {
        jid,
        senders,
        render: SEARCH_RENDER,
        openTool: "get_conversation",
        unlabelledNote: " Only chats you labelled have labels (chatkit label).",
        aboutMissNote: " Only chats you labelled have labels (chatkit label)."
      });
    }
  );
  add(
    "get_recent_messages",
    "The most recent messages in a chat, oldest-first. Use after/before (YYYY-MM-DD) to read a specific window — 'what happened last week' is after=<that Monday>, not a search.",
    {
      limit: z.number().int().min(1).max(500).default(50),
      after: z.string().optional(),
      before: z.string().optional(),
      detailed: z.boolean().default(false),
      ...chatArg
    },
    (args) => {
      const jid = jidOf(args);
      if (!jid) return "chat_jid is required — call list_chats first.";
      const { rows, matched } = db.recentMessages(jid, args.limit, {
        after: args.after,
        before: args.before
      });
      if (!rows.length) return "no messages in that window.";
      const note = matched > rows.length ? `(${matched} messages in range; showing the most recent ${rows.length} — narrow the window to page back)
` : "";
      return note + fmtRows(rows, args.detailed);
    }
  );
  add(
    "get_conversation",
    "Re-open a conversation by its [conv:xxx] handle from search_messages, with the whole episode and padding either side. This is how you widen the window around a hit — concise output has no message ids to chain on.",
    { handle: z.string(), detailed: z.boolean().default(true) },
    ({ handle, detailed }) => {
      const id = index.parseEpisodeHandle(handle);
      if (!id) return `not a conversation handle: ${JSON.stringify(handle)} (expected conv:xxx).`;
      const ep = index.getEpisode(id);
      if (!ep) return `no conversation ${handle}.`;
      if (scoped && !index.inChatScope(chatJid, ep.chat_jid)) return `no conversation ${handle}.`;
      const rows = index.episodeRows(id);
      const jump = jumpLink(ep.chat_jid, rows[0]?.id);
      const head = `[${index.episodeHandle(id)}] ${ep.started_at.slice(0, 16)} · ${ep.n_messages} msgs` + (jump ? ` · ↗${jump}` : "");
      const label = defuseTags(index.headerLine(ep));
      const fl = index.factsLine(ep);
      return [head, label, fl ? defuseTags(fl) : null, fmtRows(rows, detailed)].filter(Boolean).join("\n");
    }
  );
  add(
    "get_message_context",
    "Messages either side of a specific message id (from detailed output).",
    {
      message_id: z.string(),
      before: z.number().int().min(0).max(50).default(5),
      after: z.number().int().min(0).max(50).default(5),
      ...chatArg
    },
    (args) => {
      const jid = jidOf(args);
      if (!jid) return "chat_jid is required.";
      const ctx = db.messageContext(jid, args.message_id, args.before, args.after);
      if (!ctx) return `no message ${args.message_id} in that chat.`;
      const rows = [...ctx.before ?? [], ctx.target, ...ctx.after ?? []].filter(Boolean);
      return fmtRows(rows, true, (m) => m.id === args.message_id, "hits");
    }
  );
  add(
    "find_media",
    "Find photos, videos, documents, audio and shared links." + (scoped ? "" : " Omit chat_jid to search ALL chats.") + " USE THIS, not search_messages, whenever the question is about a picture, screenshot, video, file, PDF or a link someone sent. Attachments usually have no caption, so they are invisible to text search — search_messages returns nothing and you would wrongly conclude nobody sent one. For 'has this link been posted before?' or 'what do we share from <site>?' use find_links instead — this tool searches link TEXT, that one understands hosts and duplicates.",
    {
      kind: z.enum(["image", "video", "document", "audio", "link"]).optional(),
      query: z.string().optional(),
      sender: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      ...chatArg
    },
    (args) => {
      const senders = args.sender ? senderKeys(jidOf(args), args.sender) : null;
      if (args.sender && !senders) return noSender(args.sender);
      const rows = db.findMedia({
        kind: args.kind ?? null,
        query: args.query ?? null,
        chatJid: jidOf(args),
        senders,
        after: args.after ?? null,
        before: args.before ?? null,
        limit: args.limit
      });
      if (!rows.length) return "no matching media or links.";
      return fmtRows(rows, true, null, true);
    }
  );
  add(
    "find_links",
    "The chat's link memory: what has been shared here, from where, and whether a particular link is a repost.\n\nThree ways to call it:\n• url=<a link> — has this been posted here before? Answers with who posted it and when, or says it is new. Also reports other links from the same site, so 'new link, but we read that paper constantly' is visible.\n• host=<a domain, e.g. youtube.com> — everything shared from that site, newest first. www. and case are ignored.\n• neither — the sites this chat shares most, with counts and when each was last seen. The answer to 'what do we send each other'.\n\nsender/after/before narrow any of the three. A host is matched by PARSING each URL, not by substring, so evil.example/?ref=youtube.com is not a youtube link. For searching what was SAID around a link, or for photos and files, use find_media." + (scoped ? "" : " Omit chat_jid to look across ALL chats."),
    {
      url: z.string().optional(),
      host: z.string().optional(),
      query: z.string().optional(),
      sender: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(15),
      ...chatArg
    },
    (args) => {
      const jid = jidOf(args);
      const limit = args.limit ?? 15;
      const senders = args.sender ? senderKeys(jid, args.sender) : null;
      if (args.sender && !senders) return noSender(args.sender);
      const range = { after: args.after ?? null, before: args.before ?? null };
      const line = (l) => {
        const who = l.is_from_me ? "Me" : defuseTags(db.displayName(l.sender) ?? l.sender);
        const where = !jid && l.chat_name ? ` [${defuseTags(l.chat_name)}]` : "";
        const jump = jumpLink(l.chat_jid, l.id);
        return `[${l.timestamp.slice(0, 16)}]${where} ${who}: ${l.url.href}${jump ? ` ↗${jump}` : ""}`;
      };
      if (args.url) {
        let target;
        try {
          target = new URL(String(args.url).trim());
        } catch {
          return `${JSON.stringify(args.url)} is not a URL — pass the whole thing including https://.`;
        }
        const host = db.normalizeHost(target.hostname);
        const { links: links2 } = db.linkMessages({ chatJid: jid, host, limit: 500 });
        const same = links2.filter((l) => db.sameUrl(l.url, target));
        if (same.length) {
          const oldest = same[same.length - 1];
          const head = same.length === 1 ? `posted once, on ${oldest.timestamp.slice(0, 10)} — and that is the only time. If it is the message you are asking about, this link is new here.` : `repost — posted ${same.length} times, first on ${oldest.timestamp.slice(0, 10)}, most recently ${same[0].timestamp.slice(0, 10)}.`;
          return [head, ...same.slice(0, limit).map(line)].join("\n");
        }
        if (!links2.length) return `never — nothing from ${host} has been posted ${jid ? "in this chat" : "anywhere"}.`;
        return [
          `that exact link is new here, but ${links2.length} other${links2.length === 1 ? "" : "s"} from ${host} ${links2.length === 1 ? "has" : "have"} been posted:`,
          ...links2.slice(0, limit).map(line)
        ].join("\n");
      }
      if (args.host) {
        const host = db.normalizeHost(args.host);
        const { links: links2, total: total2 } = db.linkMessages({
          chatJid: jid,
          host,
          query: args.query ?? null,
          senders,
          ...range,
          limit
        });
        if (!links2.length) return `nothing from ${host} ${jid ? "in this chat" : "anywhere"}.`;
        const note = total2 > links2.length ? `(${total2} links from ${host}; newest ${links2.length})` : `(${total2} from ${host})`;
        return [note, ...links2.map(line)].join("\n");
      }
      const { links, total } = db.linkMessages({
        chatJid: jid,
        query: args.query ?? null,
        senders,
        ...range,
        limit: 1e5
      });
      if (!links.length) return "no links posted in that range.";
      const byHost = /* @__PURE__ */ new Map();
      for (const l of links) {
        const h = byHost.get(l.host) ?? { n: 0, last: "" };
        h.n++;
        if (l.timestamp > h.last) h.last = l.timestamp;
        byHost.set(l.host, h);
      }
      const ranked = [...byHost].sort((a, b) => b[1].n - a[1].n).slice(0, limit);
      return [
        `${total} links from ${byHost.size} sites${args.query ? ` matching ${JSON.stringify(args.query)}` : ""}. Top ${ranked.length}:`,
        ...ranked.map(([h, v]) => `${String(v.n).padStart(5)}  ${h.padEnd(28)} last ${v.last.slice(0, 10)}`),
        "",
        "Pass host= to see the links from any of these, or url= to check a specific one for reposts."
      ].join("\n");
    }
  );
  add(
    "get_chat_members",
    "Who talks in a chat, most active first — the answer to 'who is who'.",
    { ...chatArg },
    (args) => {
      const jid = jidOf(args);
      if (!jid) return "chat_jid is required.";
      const rows = db.chatMembers(jid);
      if (!rows.length) return "no members recorded.";
      return rows.map((m) => `${String(m.sender).padStart(14)}  ${String(m.messages).padStart(6)} msgs  last ${String(m.last).slice(0, 10)}  ${defuseTags(m.name)}`).join("\n");
    }
  );
  if (!scoped) {
    add(
      "list_chats",
      "List Telegram chats, most recently active first. Returns the chat id to pass to the other tools, the title, and how many messages are stored.",
      { query: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) },
      ({ query, limit }) => {
        const rows = db.listChats(200).filter((c) => !query || (c.name ?? "").toLowerCase().includes(query.toLowerCase())).slice(0, limit);
        if (!rows.length) return "no chats match.";
        return rows.map((c) => {
          const s = db.chatStats(c.jid);
          const kind = String(c.jid).startsWith("-") ? "group" : "dm";
          return `${c.jid}  ${kind.padEnd(5)}  ${String(s?.total ?? 0).padStart(6)} msgs  ${defuseTags(c.name ?? "(no title)")}`;
        }).join("\n");
      }
    );
    add(
      "search_contacts",
      "Find people by name, @username or numeric id, across all chats.",
      { query: z.string(), limit: z.number().int().min(1).max(50).default(20) },
      ({ query, limit }) => {
        const rows = db.searchContacts(query, limit);
        if (!rows.length) return `nobody matches ${JSON.stringify(query)}.`;
        return rows.map((r) => `${String(r.id).padStart(14)}  ${String(r.messages).padStart(6)} msgs  ${defuseTags(r.name ?? "")}${r.username ? ` (@${r.username})` : ""}`).join("\n");
      }
    );
  }
  return tools;
}
export {
  buildTools
};
