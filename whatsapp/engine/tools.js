// chatkit — WhatsApp read tools for the MCP server. Read-only: nothing here
// sends, and the bridge chatkit builds has no send routes at all.
//
// Each tool is {name, description, schema, handler}; the handler resolves to
// a string. search_messages and get_conversation come from the shared engine
// (tools-search.js); the rest read the bridge store through db.js.
import { z } from "zod";
import * as db from "./db.js";
import { buildTools as searchTools, conversationText } from "./tools-search.js";
import { defuseTags, fmtRows, whoSent, ownSticker } from "./render.js";

const OWNER = { name: "chatkit", scope: "global", revisions: true };
const chatArg = { chat_jid: z.string().optional() };

function senderKeys(name) {
  const keys = db.resolveSenderKeys(String(name));
  return keys.length ? keys : null;
}

export function buildTools() {
  const tools = searchTools({ bot: OWNER, chatJid: null, openTool: "get_conversation" });
  const add = (name, description, schema, handler) => tools.push({ name, description, schema, handler });

  add(
    "get_conversation",
    "Open one conversation by its [conv:…] handle from search_messages, whole, with" +
      " before/after messages of padding. Use it when a block was trimmed, or to see" +
      " what was said just before or after.",
    {
      handle: z.string(),
      before: z.number().int().min(0).max(50).default(0),
      after: z.number().int().min(0).max(50).default(0),
    },
    (args) => conversationText(args.handle, { before: args.before ?? 0, after: args.after ?? 0, revisions: true })
  );

  add(
    "get_recent_messages",
    "Read a chat's messages, oldest first. Pass after/before (YYYY-MM-DD or full ISO)" +
      " to read a period — 'what happened last week' is after=<that Monday>, not a search." +
      " To FIND something specific use search_messages; for attachments or links use find_media.",
    {
      limit: z.number().int().min(1).max(500).default(30),
      after: z.string().optional(),
      before: z.string().optional(),
      detailed: z.boolean().default(false),
      chat_jid: z.string(),
    },
    (args) => {
      const { rows, matched } = db.recentMessages(args.chat_jid, args.limit ?? 30, { after: args.after, before: args.before });
      if (!rows.length) return "(no messages in that range)";
      const note =
        matched > rows.length
          ? `(showing the ${rows.length} most recent of ${matched} messages in this range — raise limit or narrow the window)\n`
          : "";
      return note + fmtRows(rows, args.detailed === true, null, { revisions: true });
    }
  );

  add(
    "get_message_context",
    "The messages around one message id (from a detailed search or find_media result).",
    {
      chat_jid: z.string(),
      message_id: z.string(),
      before: z.number().int().min(0).max(50).default(5),
      after: z.number().int().min(0).max(50).default(5),
    },
    (args) => {
      const ctx = db.messageContext(args.chat_jid, args.message_id, args.before ?? 5, args.after ?? 5);
      if (!ctx) return "message id not found";
      return [
        fmtRows(ctx.before, true, null, { revisions: true }),
        ">>> " + fmtRows([ctx.target], true, null, { revisions: true }),
        fmtRows(ctx.after, true, null, { revisions: true }),
      ]
        .filter(Boolean)
        .join("\n");
    }
  );

  add(
    "find_media",
    "Find photos, videos, documents, audio and shared links. Omit chat_jid to search ALL" +
      " chats. Use this, not search_messages, for a picture, file or link someone sent:" +
      " attachments usually have no caption, so text search cannot see them." +
      " kind: image | video | document | audio | link. query matches the caption or" +
      " filename. Newest first.",
    {
      kind: z.enum(["image", "video", "document", "audio", "link"]).optional(),
      query: z.string().optional(),
      sender: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
      ...chatArg,
    },
    (args) => {
      let senders = null;
      if (args.sender) {
        senders = senderKeys(args.sender);
        if (!senders) return `no contact matching "${args.sender}" — try get_chat_members or a phone number`;
      }
      const rows = db.findMedia({
        kind: args.kind || null,
        query: args.query || null,
        chatJid: args.chat_jid || null,
        senders,
        after: args.after || null,
        before: args.before || null,
        limit: args.limit ?? 20,
      });
      if (!rows.length) return "(no matching attachments or links)";
      return rows
        .map((m) => {
          const what = ownSticker(m)?.what ?? (m.media_type ? `<${m.media_type}>` : "<link>");
          const file = m.filename ? ` ${defuseTags(m.filename)}` : "";
          const size = m.file_length ? ` (${Math.round(m.file_length / 1024)}kb)` : "";
          const body = defuseTags(m.content || "").trim();
          return `[${m.timestamp}] ${whoSent(m)}: ${what}${file}${size}${body ? ` — ${body}` : ""} (chat ${m.chat_jid}, id:${m.id})`;
        })
        .join("\n");
    }
  );

  add(
    "get_chat_members",
    "Who has written in a chat (name, sender id, message count) — the answer to 'who is who'.",
    { chat_jid: z.string() },
    (args) =>
      db
        .chatMembers(args.chat_jid)
        .map((m) => `${defuseTags(m.name ?? "(unknown)")} — ${m.sender} — ${m.messages} msgs, last ${m.last}`)
        .join("\n") || "(no members found)"
  );

  add(
    "list_chats",
    "List WhatsApp chats, most recently active first: the chat_jid to pass to the other" +
      " tools and the chat's name. query filters by name.",
    { query: z.string().optional(), limit: z.number().int().min(1).max(200).default(30) },
    (args) => {
      const q = (args.query ?? "").toLowerCase();
      const rows = db
        .listChats(1000)
        .filter((c) => !q || String(c.name ?? "").toLowerCase().includes(q) || String(c.jid).includes(q))
        .slice(0, args.limit ?? 30);
      if (!rows.length) return "no chats match.";
      return rows
        .map((c) => {
          const kind = String(c.jid).endsWith("@g.us") ? "group" : "dm";
          return `${c.jid}  ${kind.padEnd(5)}  last ${String(c.last_message_time ?? "").slice(0, 10)}  ${defuseTags(c.name ?? "(no name)")}`;
        })
        .join("\n");
    }
  );

  add(
    "search_contacts",
    "Find contacts by name or phone number.",
    { query: z.string(), limit: z.number().int().min(1).max(50).default(20) },
    (args) => {
      const rows = db.searchContacts(args.query, args.limit ?? 20);
      if (!rows.length) return `nobody matches ${JSON.stringify(args.query)}.`;
      return rows.map((r) => `${r.phone}  ${defuseTags(r.name ?? "")}`).join("\n");
    }
  );

  return tools;
}
