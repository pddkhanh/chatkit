import { z } from "zod";
import * as db from "./db.js";
import * as index from "./searchindex.js";
import { searchMessages } from "./searchtool.js";
import { personSenders } from "./people.js";
import { fmtRows, defuseTags, searchRender, chatTitle } from "./render.js";
function syncOrStale(what) {
  try {
    index.sync();
  } catch (e) {
    console.error(`${(/* @__PURE__ */ new Date()).toISOString()} index sync failed before ${what}: ${e?.message ?? e} — searching the index as it is`);
  }
}
function senderKeys(chatJid, name) {
  const configured = personSenders(chatJid, name);
  if (configured) return configured;
  const keys = db.resolveSenderKeys(String(name));
  return keys.length ? keys : null;
}
const noSender = (name) => `no contact matching ${JSON.stringify(name)} — try get_chat_members or a phone number`;
function searchDescription(scoped, openTool) {
  return (scoped ? "Search this chat's entire history." : "Search message history. Omit chat_jid to search ALL chats.") + ` Returns CONVERSATIONS, best first: the top few in full ('>>>' marks the matching lines), then one line per further match with its [conv:xxx] handle, label and best line — open any of them with ${openTool === "get_message_context" ? "get_message_context(episode=…)" : openTool}. Query: words must all appear in one message, any order; "quoted phrase" = exact run; a OR b = either (quote multi-word alternatives: "lao di fang" OR 老地方); -word excludes; word* = prefix. Whole words, accents ignored (dam cuoi finds đám cưới; in Vietnamese chats ko finds không, vk finds vợ); typing the accents ranks that spelling first. A sentence still works: if no message holds every word it retries with the rarest ones, then any of them, and says so. Chinese is matched as written. query also matches each conversation's LABEL (English: register · who it is about · topic, plus its people, keywords and facts — a '≡ facts:' line under the label), so English words find a Vietnamese or Chinese thread. Conversations close in MEANING are added too, marked ≈ (no shared word needed) — check those; words typed as written still rank first. About a PERSON (what X said, is like, has been up to): set about='X' — any of their names or nicknames — instead of putting the name in query; it finds conversations ABOUT X whoever was talking, including the lines that only say "he" or "her". sender= keeps one person's messages (same names; never the bots' replies). after/before take YYYY-MM-DD, both days included; sort=recent = newest first; limit = how many conversations; context:0 = only the matching lines. The name before a colon is who TYPED a line, not who it is about: trust the block's '≡ register · about X · topic' line for that. Photos, videos, documents or links: use find_media, as captions are often empty.`;
}
function buildTools({ bot = {}, chatJid = null, openTool = "get_message_context" } = {}) {
  const scoped = bot.scope !== "global";
  const revisions = bot.revisions === true;
  return [
    {
      name: "search_messages",
      description: searchDescription(scoped, openTool),
      schema: {
        query: z.string().optional(),
        sender: z.string().optional().describe("who TYPED the message — a name, nickname or phone number"),
        about: z.string().optional().describe(
          "SET THIS whenever the question is about a person. Who the conversation is ABOUT — the subject of the claims, not the speaker. Any of their names or nicknames works. Use it INSTEAD of putting the name in query, or alongside a topic word."
        ),
        after: z.string().optional().describe("'YYYY-MM-DD' or full ISO"),
        before: z.string().optional().describe("'YYYY-MM-DD' (that day included) or full ISO"),
        sort: z.enum(["relevance", "recent"]).default("relevance"),
        context: z.number().int().min(0).max(5).default(2).describe("0 skips the conversations and returns only the matching lines"),
        limit: z.number().int().min(1).max(100).default(25),
        response_format: z.enum(["concise", "detailed"]).default("concise").describe("'detailed' adds message ids; only when you need one for another tool"),
        ...scoped ? {} : { chat_jid: z.string().optional() }
      },
      // `extra.info`, when passed, receives {queries: [...]} — every query the
      // retries actually ran (agent.js records them for its repeat check).
      handler: async (args, extra = {}) => {
        if (!args.query && !args.about && !args.sender && !args.after && !args.before)
          return "provide query, about, sender and/or after/before";
        syncOrStale("search_messages");
        let jid = scoped ? chatJid : args.chat_jid || null;
        const notes = [];
        if (!scoped && jid && !index.hasChat(jid)) {
          notes.push(`(no chat ${JSON.stringify(jid)} has any messages — searched every chat instead; list_chats gives the ids)`);
          jid = null;
        }
        const senders = args.sender ? senderKeys(jid, args.sender) : null;
        if (args.sender && !senders) return noSender(args.sender);
        const detailed = args.response_format === "detailed";
        const text = await searchMessages(
          { ...args, detailed },
          {
            jid,
            senders,
            render: searchRender({ revisions, spansChats: !jid, chatIds: detailed }),
            openTool,
            unlabelledNote: "",
            aboutMissNote: " Only chats you labelled have labels (chatkit label).",
            info: extra.info
          }
        );
        return notes.length ? `${notes.join("\n")}
${text}` : text;
      }
    }
  ];
}
function conversationText(handle, { before = 5, after = 5, scopeJid = null, revisions = false } = {}) {
  syncOrStale("get_conversation");
  const ep = index.episodeContext(handle, before, after);
  if (!ep || scopeJid && !index.inChatScope(scopeJid, ep.episode.chat_jid))
    return "no conversation with that handle";
  const rows = [...ep.before, ...ep.rows, ...ep.after].map((m) => ({ ...m, chat_jid: ep.episode.chat_jid }));
  const head = `[${ep.handle}] ${ep.episode.started_at.slice(0, 16)}–${ep.episode.ended_at.slice(11, 16)} · ${ep.episode.n_messages} msgs` + (ep.before.length || ep.after.length ? ` (+${ep.before.length} before, +${ep.after.length} after)` : "") + (scopeJid ? "" : ` · in ${defuseTags(chatTitle(ep.episode.chat_jid))} (chat_jid ${ep.episode.chat_jid})`);
  const label = defuseTags(index.headerLine(ep.episode));
  const fl = index.factsLine(ep.episode);
  return [head, label, fl ? defuseTags(fl) : null, fmtRows(rows, true, null, { revisions })].filter(Boolean).join("\n");
}
export {
  buildTools,
  conversationText,
  noSender,
  senderKeys
};
