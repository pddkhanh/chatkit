// chatkit search engine — labelfields.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import crypto from "node:crypto";
import { z } from "zod";
import { BIP39_ENGLISH } from "./bip39words.js";
const LABEL_VERSION = 2;
const REGISTERS = ["joke", "fact", "plan", "gossip"];
const KEYWORDS_MAX = 24;
const FACTS_MAX = 6;
const PEOPLE_MAX = 40;
const topic = z.string().trim().min(1).max(400).describe("What the conversation is about, one short clause under 90 characters.");
const about = z.string().trim().min(1).max(200).describe("Who it is ABOUT — the subject of the claims, not whoever typed them.");
const register = z.enum(REGISTERS).describe("joke | fact | plan | gossip");
const people = z.array(z.string().trim().max(120)).describe("Everyone involved or mentioned, one entry per person, under the name the notes use.");
const keywords = z.array(z.string().trim().max(120)).describe("10-20 search terms: as the chat writes them, in standard spelling, and in English.");
const facts = z.array(
  z.object({
    text: z.string().trim().max(600).describe("One short English sentence stating a concrete detail."),
    msgs: z.array(z.number().int()).describe("The numbers (#n) of the messages that state it.")
  })
).describe("At most 5 concrete details, each citing its messages.");
const CORE_SHAPE = { topic, about, register };
const FIELDS_SHAPE = { people, keywords, facts };
const CORE_ITEM = z.object(CORE_SHAPE);
const FIELDS_ITEM = z.object(FIELDS_SHAPE);
const FULL_ITEM = z.object({ ...CORE_SHAPE, ...FIELDS_SHAPE });
const itemFor = (kind) => kind === "fields" ? FIELDS_ITEM : kind === "core" ? CORE_ITEM : FULL_ITEM;
const UNSUPPORTED = ["$schema", "minLength", "maxLength", "minimum", "maximum", "multipleOf", "minItems", "maxItems"];
function forWire(node) {
  if (Array.isArray(node)) return node.map(forWire);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).filter(([k]) => !UNSUPPORTED.includes(k)).map(([k, v]) => [k, forWire(v)])
  );
}
const CORE_JSON_SCHEMA = forWire(z.toJSONSchema(CORE_ITEM));
const FIELDS_JSON_SCHEMA = forWire(z.toJSONSchema(FIELDS_ITEM));
const FULL_JSON_SCHEMA = forWire(z.toJSONSchema(FULL_ITEM));
const schemaFor = (kind) => kind === "fields" ? FIELDS_JSON_SCHEMA : kind === "core" ? CORE_JSON_SCHEMA : FULL_JSON_SCHEMA;
const LABEL_INSTRUCTIONS = `You label conversations from a group chat (WhatsApp or Telegram). Each label is stored in a search index and shown above the conversation when it is retrieved, so a reader sees what the exchange was about before reading a word of it — and so a later search can find the conversation by its people, its words and its details.

You are given NOTES about the group (who is who, its in-jokes, its vocabulary) and then ONE CONVERSATION, one message per line, each line starting with the message's number (#1, #2, …). The request says which fields to return: all six (topic, about, register, people, keywords, facts), or — when the conversation already has its label, shown to you as context — only people, keywords and facts.

topic — what this conversation is actually about, one clause under 90 characters. Be concrete: "Linh's Shanghai flight, business class on miles" beats "travel plans". Write it for someone who was not there: expand the group's shorthand using the notes, and name people rather than saying "he" or "she". If the burst covers several things, take the one most of it is about.

about — WHO the conversation is about. This is the SUBJECT, not the speaker. The person who typed the most messages is very often not the answer: someone repeating a claim about a third person is talking ABOUT that third person. Rules:
- Name the person or people the claims are about, as the group writes their name. One or two names, comma-separated.
- A person outside the chat still counts — name them.
- "the group" when it is about everyone collectively.
- "nobody" when there is no human subject at all (a link, a photo, a football score, pure logistics with no one's situation in it).
- "unclear" when you genuinely cannot tell. This is a real answer and a better one than guessing the loudest speaker. Do not guess.
These chats are extremely elliptical — "told you 20k", "the condo", "she said no". The referent frequently is not in this conversation at all. That is what the notes are for: resolve it from them. If the notes do not settle it, "unclear".

register — exactly one of:
- joke — teasing, a bit, hyperbole, a running gag. The claims in it are not meant literally.
- fact — sincere exchange of information; the claims are meant to be taken at face value.
- plan — arranging something that has not happened yet: meeting up, booking, buying, scheduling.
- gossip — sincere talk about a third party who is not in the conversation.
Pick the dominant one. Two rules override the surface reading:
- If the notes record something as a running joke or a rumour, a conversation repeating it is "joke" even when the messages state it completely flatly. A bit told deadpan for the twentieth time is still a bit.
- Laughter, emoji, implausibility on its face, or the subject objecting ("don't anyhow say", "别乱讲", "who said") all point to joke.

people — everyone involved in or mentioned in the conversation: the people who wrote in it and the people they talk about, inside the chat or outside it. One entry per person, under the name the notes use for them — never the same person twice under two names ("Minh" and "a Minh", "Tom" and "Tommy"). Someone the notes do not know: their name as the chat writes it, without a leading title (a, anh, chị, em, ku, Mr). Real people only: no "the group", no pronouns, no bot unless the conversation is about the bot. [] when there is nobody.

keywords — 10 to 20 search terms a member might type later to find this conversation. Cover each important thing in up to three forms, as separate entries when they differ:
- as the chat itself writes it — its own language, spelling and shorthand: Vietnamese without accents, teen code, Singlish, Chinese characters;
- in standard spelling — Vietnamese with its full accents;
- in English.
Concrete things: places, products, dishes, events, nicknames and running jokes, amounts and numbers that matter, organisations. One to three words each. Not people's names (they are in people), and no filler such as "chat", "conversation", "discussion" or "message".

facts — at most 5 short English statements of concrete details someone might ask about later: names, who is related to whom, places, prices and other numbers, dates and times, decisions taken, what was bought, booked or agreed. Each fact:
- is one standalone sentence that names people instead of saying he or she;
- says only what its messages say — no guesses and no conclusions of your own;
- cites in msgs the numbers of the message or messages that state it (#3 is 3): at least one, and only numbers shown in this conversation.
A joke, a tease or a running gag is not a fact; if it matters, state it as what was said ("Linh joked that Sam earns 20k"). Fewer facts are better than vague ones; [] when nothing concrete was said.

Write topic, about and facts in English regardless of the language of the conversation. Do not add quotes, hedging or explanation — the fields are the whole output.

WORKED EXAMPLES. Names here are invented; do not carry them into your answers.

1. The notes say "'the Ferrari' = running joke that Marcus is always about to buy one". The conversation is six messages: Priya says "eh when is the Ferrari coming", Tomas says "next year lah same as last year", Marcus sends a laughing emoji.
   topic: the running joke that Marcus is about to buy a Ferrari
   about: Marcus
   register: joke
   Priya started it and Tomas said the most, but neither is the subject.

2. Priya writes "he said 8k bonus", Tomas writes "wah", Priya writes "for one quarter only", Tomas writes "who". Nobody answers.
   topic: an unnamed colleague's reported 8k quarterly bonus
   about: unclear
   register: gossip
   "he" is never resolved and the notes do not settle it. "unclear" is the correct answer; picking Priya because she typed it would be wrong.

3. Fourteen messages settling a dinner: Tomas proposes Saturday, Marcus says he is free after 7, Priya books a table for five.
   topic: Saturday dinner booking, table for five after 7pm
   about: the group
   register: plan

4. The notes say Priya left her job in March. The conversation is Priya answering questions about the new place, sincerely, at length.
   topic: Priya's new job — team, commute, first impressions
   about: Priya
   register: fact
   She is both the speaker and the subject here. That happens; it is just not the default.

5. Four messages in Vietnamese: #1 Marcus "t book Hoàng Yến Q1 tối t7 nha, 6 ng", #2 Priya "ok mấy h a", #3 Marcus "7h", #4 Tomas "e tới trễ 30p, kẹt đón bé Su".
   topic: Saturday dinner at Hoang Yen in District 1, 7pm, six people
   about: the group
   register: plan
   people: ["Marcus", "Priya", "Tomas", "Su"]
   keywords: ["hoang yen", "Hoàng Yến", "nha hang", "nhà hàng", "restaurant", "an toi", "ăn tối", "dinner", "t7", "thứ 7", "Saturday", "q1", "Quận 1", "District 1", "dat ban", "đặt bàn", "booking"]
   facts: [{"text": "Marcus booked Hoang Yen restaurant in District 1 for Saturday evening for six people.", "msgs": [1]}, {"text": "The dinner is at 7pm.", "msgs": [3]}, {"text": "Tomas will be 30 minutes late because he is picking up Su.", "msgs": [4]}]
   Su is only mentioned, and still counts as a person. Each fact cites only the message that says it.`;
const NOTES_HEADER = "NOTES ON THIS GROUP — background, not part of the conversation. Use them to resolve who and what the messages refer to.";
const PROMPT_HASH = crypto.createHash("sha1").update(JSON.stringify([LABEL_VERSION, LABEL_INSTRUCTIONS, NOTES_HEADER, CORE_JSON_SCHEMA, FIELDS_JSON_SCHEMA, FULL_JSON_SCHEMA])).digest("hex").slice(0, 12);
function numberRows(rows, who) {
  return rows.map((m, i) => {
    const media = m.media_type ? ` <${m.media_type}>` : "";
    return `#${i + 1} [${String(m.timestamp ?? "").slice(0, 16)}] ${who(m)}:${media} ${m.content ?? ""}`;
  }).join("\n");
}
const SEED_WORDS = /* @__PURE__ */ new Set([12, 15, 18, 21, 24]);
const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["api key", /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/]
];
const URLISH = /:\/\/|^www\.|[/?=&]/;
function secretLike(rows) {
  for (const r of rows ?? []) {
    const text = String(r?.content ?? "");
    if (!text.trim()) continue;
    for (const [why, re] of SECRET_PATTERNS) if (re.test(text)) return why;
    const tokens = text.split(/[\s,;]+/).filter(Boolean);
    const words = tokens.map((t) => t.toLowerCase().replace(/^\d{1,2}[.):-]?/, "")).filter(Boolean);
    if (SEED_WORDS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w)) && words.filter((w) => !BIP39_ENGLISH.has(w)).length <= 1)
      return "recovery phrase";
    for (const t of tokens) {
      if (URLISH.test(t)) continue;
      if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(t)) return "private key";
      if (/^[1-9A-HJ-NP-Za-km-z]{85,90}$/.test(t)) return "private key";
    }
  }
  return null;
}
function rowsKey(rows) {
  return crypto.createHash("sha1").update(rows.map((r) => String(r.id)).join("\n")).digest("hex").slice(0, 10);
}
const KIND_CODE = { full: "l", fields: "f", core: "c" };
const CODE_KIND = { l: "full", f: "fields", c: "core" };
const customId = (episodeId, kind, key) => `ep-${Number(episodeId)}-${KIND_CODE[kind] ?? "l"}-${key}`;
function parseCustomId(s) {
  const m = /^ep-(\d+)(?:-([lfc])-([0-9a-f]+))?$/.exec(String(s ?? ""));
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id)) return null;
  return m[2] ? { id, kind: CODE_KIND[m[2]], key: m[3] } : { id, kind: "core", key: null, legacy: true };
}
function mapRefs(value, msgIds) {
  if (!value?.facts) return value;
  const facts2 = value.facts.map((f) => ({
    text: f.text,
    msgs: (f.msgs ?? []).map((n) => {
      const i = Number(n);
      return msgIds && Number.isInteger(i) && i >= 1 && i <= msgIds.length ? String(msgIds[i - 1]) : `#${n}`;
    })
  }));
  return { ...value, facts: facts2 };
}
const THINKING_OFF = { "claude-sonnet-5-5": "between_tools" };
const thinkingType = (model, thinking) => thinking === "disabled" ? THINKING_OFF[model] ?? "disabled" : thinking;
const LABEL_MAX_TOKENS = 6e3;
const BULK_MAX_TOKENS = 1500;
const bulkMaxTokens = (thinking) => thinking === "disabled" ? BULK_MAX_TOKENS : LABEL_MAX_TOKENS;
const CACHE_TTL = "1h";
const labelBlock = (label) => [`  register: ${label?.register ?? "?"}`, `  about: ${label?.about ?? "?"}`, `  topic: ${label?.topic ?? "?"}`].join("\n");
function buildRequest({
  kind = "full",
  text,
  head,
  notes = null,
  label = null,
  model,
  effort,
  thinking,
  maxTokens = LABEL_MAX_TOKENS,
  cacheTtl = CACHE_TTL
}) {
  const cache = cacheTtl ? { type: "ephemeral", ttl: cacheTtl } : { type: "ephemeral" };
  const system = [{ type: "text", text: LABEL_INSTRUCTIONS, cache_control: cache }];
  if (notes) system.push({ type: "text", text: `${NOTES_HEADER}

${notes}`, cache_control: cache });
  const ask = kind === "fields" ? `ITS LABEL — already written; use it as context and do not rewrite it:
${labelBlock(label)}

Return only people, keywords and facts for this conversation.` : kind === "core" ? "Label this conversation: topic, about and register." : "Label this conversation: all six fields.";
  return {
    model,
    max_tokens: maxTokens,
    system,
    thinking: { type: thinkingType(model, thinking) },
    output_config: { effort, format: { type: "json_schema", schema: schemaFor(kind) } },
    messages: [{ role: "user", content: `CONVERSATION — ${head}

${text}

${ask}` }]
  };
}
function countBody(params) {
  const { max_tokens, ...rest } = params;
  return rest;
}
function parseMessage(message, kind) {
  const stop = message?.stop_reason ?? null;
  const text = (message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (stop === "refusal")
    return { error: { type: "refusal", stop_reason: stop, stop_details: message?.stop_details?.category ?? null, sample: text.slice(0, 160) } };
  if (!text) return { error: { type: "empty", stop_reason: stop, output_tokens: message?.usage?.output_tokens ?? null } };
  try {
    return { value: itemFor(kind).parse(JSON.parse(text)) };
  } catch (e) {
    return {
      error: {
        type: "unparseable",
        stop_reason: stop,
        output_tokens: message?.usage?.output_tokens ?? null,
        sample: text.slice(0, 160),
        detail: String(e?.message ?? e).slice(0, 200)
      }
    };
  }
}
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const keyOf = (s) => squash(s).normalize("NFC").toLowerCase();
function dedupe(list, max) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  let trimmed = 0;
  for (const raw of list ?? []) {
    const s = squash(raw);
    if (!s) continue;
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    if (out.length >= max) {
      trimmed++;
      continue;
    }
    out.push(s);
  }
  return { out, trimmed };
}
function cleanFields(raw, { resolve = null, factsMax = FACTS_MAX } = {}) {
  const canon = (n) => {
    const s = squash(n);
    if (!s) return "";
    try {
      return resolve?.(s) || s;
    } catch {
      return s;
    }
  };
  const p = dedupe((raw?.people ?? []).map(canon), PEOPLE_MAX);
  const k = dedupe(raw?.keywords ?? [], KEYWORDS_MAX);
  const facts2 = [];
  let factTrim = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const f of raw?.facts ?? []) {
    const text = squash(f?.text);
    if (!text || seen.has(keyOf(text))) continue;
    seen.add(keyOf(text));
    if (facts2.length >= factsMax) {
      factTrim++;
      continue;
    }
    facts2.push({ text, msgs: [...new Set((f?.msgs ?? []).map(String))] });
  }
  return { people: p.out, keywords: k.out, facts: facts2, trimmed: p.trimmed + k.trimmed + factTrim };
}
const PRICES = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.05 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longPrompt: { over: 1e5, factor: 5 } }
};
const CACHE_MIN_TOKENS = {
  "claude-opus-5": 512,
  "claude-opus-5-5": 512,
  "claude-sonnet-5": 1024,
  "claude-sonnet-5-5": 512,
  "claude-haiku-5-5": 512
};
const CACHE_WRITE_MULTIPLIER = CACHE_TTL === "1h" ? 2 : 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
const BATCH_DISCOUNT = 0.5;
function emptyUsage() {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}
function addUsage(total, u) {
  if (!u) return total;
  total.calls += u.calls ?? 1;
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])
    total[k] += u[k] ?? 0;
  return total;
}
function priceModel(reported, requested) {
  if (reported && PRICES[reported]) return reported;
  if (reported) {
    const base = Object.keys(PRICES).filter((k) => String(reported).startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
    if (base) return base;
  }
  return PRICES[requested] ? requested : null;
}
function costOf(usage, { batch = true, model } = {}) {
  const p = PRICES[model];
  if (!p) return NaN;
  const m = 1e-6 * (batch ? BATCH_DISCOUNT : 1);
  return (usage.input_tokens ?? 0) * p.input * m + (usage.cache_creation_input_tokens ?? 0) * p.input * CACHE_WRITE_MULTIPLIER * m + (usage.cache_read_input_tokens ?? 0) * p.input * (p.cacheRead ?? CACHE_READ_MULTIPLIER) * m + (usage.output_tokens ?? 0) * p.output * m;
}
function requestCost(u, { batch = true, model } = {}) {
  const p = PRICES[model];
  if (!p) return NaN;
  const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const factor = p.longPrompt && prompt > p.longPrompt.over ? p.longPrompt.factor : 1;
  return costOf({ ...emptyUsage(), ...u }, { batch, model }) * factor;
}
export {
  BATCH_DISCOUNT,
  BULK_MAX_TOKENS,
  CACHE_MIN_TOKENS,
  CACHE_READ_MULTIPLIER,
  CACHE_TTL,
  CACHE_WRITE_MULTIPLIER,
  CORE_ITEM,
  CORE_JSON_SCHEMA,
  CORE_SHAPE,
  FACTS_MAX,
  FIELDS_ITEM,
  FIELDS_JSON_SCHEMA,
  FIELDS_SHAPE,
  FULL_ITEM,
  FULL_JSON_SCHEMA,
  KEYWORDS_MAX,
  LABEL_INSTRUCTIONS,
  LABEL_MAX_TOKENS,
  LABEL_VERSION,
  NOTES_HEADER,
  PEOPLE_MAX,
  PRICES,
  PROMPT_HASH,
  REGISTERS,
  THINKING_OFF,
  addUsage,
  buildRequest,
  bulkMaxTokens,
  cleanFields,
  costOf,
  countBody,
  customId,
  emptyUsage,
  forWire,
  itemFor,
  mapRefs,
  numberRows,
  parseCustomId,
  parseMessage,
  priceModel,
  requestCost,
  rowsKey,
  schemaFor,
  secretLike,
  thinkingType
};
