// chatkit — label past conversations with Claude, on the user's own API key.
//
// A label is an English header per conversation: topic, who it is about,
// register (joke / fact / plan / gossip), people, keywords and facts. Search
// matches it, so an English question finds a Vietnamese or Chinese thread, and
// about= can filter by who a conversation is about.
//
// Rules this file keeps:
//   * one or more chats, always named — there is no "label everything";
//   * a $0 dry run first, which prints the count and a cost CEILING;
//   * a budget: the run refuses to start when the ceiling is above it;
//   * the Batch API (half price); a crash loses nothing, since each batch id is
//     recorded before polling and the next run picks it up;
//   * a conversation that looks like it holds a password or key is never sent.
import { loadEnv } from "./env.js";
import { stores } from "./paths.js";

const MODEL = "claude-sonnet-5-5";
const EFFORT = "high";
const THINKING = "disabled";
const CHUNK = 2000; // requests per batch
const OUT_TOKENS_EST = 480; // measured mean output of a full label
const QUIET_HOURS = 2; // a conversation still going on is labelled next time
const POLL_MS = Number(process.env.CHATKIT_POLL_MS) || 20_000;

const usd = (x) => `$${x.toFixed(x < 1 ? 4 : 2)}`;
const n = (x) => new Intl.NumberFormat("en").format(x);

async function engine(platform) {
  const s = stores(platform);
  const db = await import(`../${platform}/engine/db.js`);
  const index = await import(`../${platform}/engine/searchindex.js`);
  const L = await import(`../${platform}/engine/labelfields.js`);
  const plat = await import(`../${platform}/engine/searchplatform.js`);
  const { estimateTokens } = await import(`../${platform}/engine/trace.js`);
  db.configureDb(s.messages);
  index.configureSearch(s.messages, s.search);
  index.sync();
  const owner = process.env.CHATKIT_OWNER_NAME || "Me";
  const who = (m) => (m.is_from_me ? owner : (plat.contactName(m.sender) ?? m.sender));
  return { db, index, L, plat, estimateTokens, who };
}

function request(E, ep, rows) {
  const head = `${rows.length} messages, ${ep.started_at?.slice(0, 16) ?? "?"} to ${ep.ended_at?.slice(11, 16) ?? "?"}`;
  const params = E.L.buildRequest({
    kind: "full",
    text: E.L.numberRows(rows, E.who),
    head,
    notes: null,
    model: MODEL,
    effort: EFFORT,
    thinking: THINKING,
    maxTokens: E.L.bulkMaxTokens(THINKING),
  });
  return { custom_id: E.L.customId(ep.id, "full", E.L.rowsKey(rows)), params };
}

// Work out what would be sent: the requests, and what was left out and why.
function plan(E, chats) {
  const eps = E.index.unlabeledEpisodes({
    limit: 1e9,
    chats,
    endedBefore: E.index.indexStamp(Date.now() - QUIET_HOURS * 3600e3),
    skipRefused: true,
  });
  const requests = [];
  const secret = [];
  let inTokens = 0;
  const instrTokens = E.estimateTokens(E.L.LABEL_INSTRUCTIONS);
  for (const ep of eps) {
    const rows = E.index.episodeRows(ep.id);
    if (!rows.length) continue;
    const why = E.L.secretLike(rows);
    if (why) {
      secret.push({ id: ep.id, why });
      continue;
    }
    const r = request(E, ep, rows);
    inTokens += instrTokens + E.estimateTokens(r.params.messages[0].content) + 400; // + schema
    requests.push(r);
  }
  // Ceiling: every prompt billed in full, as if the cache never hit, plus a
  // 30% margin on our token estimate. The real bill is usually well under it.
  const ceiling =
    E.L.requestCost({ input_tokens: Math.round(inTokens * 1.3), output_tokens: requests.length * OUT_TOKENS_EST }, { batch: true, model: MODEL });
  return { requests, secret, ceiling };
}

async function client() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set. Run `chatkit setup` or add it to .env.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: key });
}

// Read a finished batch back and save every label it holds.
async function collect(E, api, batchId, log) {
  const t = { saved: 0, stale: 0, refused: 0, errors: 0, cost: 0 };
  for await (const r of await api.messages.batches.results(batchId)) {
    const cid = E.L.parseCustomId(r.custom_id);
    if (!cid || r.result?.type !== "succeeded") {
      t.errors++;
      continue;
    }
    const m = r.result.message;
    t.cost += E.L.requestCost(m.usage ?? {}, { batch: true, model: E.L.priceModel(m.model, MODEL) }) || 0;
    const rows = E.index.episodeRows(cid.id);
    if (!cid.key || E.L.rowsKey(rows) !== cid.key) {
      t.stale++; // the conversation changed since; the next run asks again
      continue;
    }
    const parsed = E.L.parseMessage(m, cid.kind);
    if (parsed.error) {
      if (parsed.error.type === "refusal") {
        E.index.saveLabelResult(cid.id, { kind: cid.kind, status: "refused", key: cid.key }, { model: MODEL });
        t.refused++;
      } else t.errors++;
      continue;
    }
    const value = E.L.mapRefs(parsed.value, rows.map((x) => String(x.id)));
    const s = E.index.saveLabelResult(cid.id, { kind: cid.kind, status: "ok", key: cid.key, ...value }, { model: MODEL });
    if (s.label || s.fields) t.saved++;
    else if (s.stale) t.stale++;
  }
  E.index.closeBatch(batchId);
  log(`  batch ${batchId}: ${n(t.saved)} labelled, ${t.stale} changed since (asked again next run), ${t.refused} refused, ${t.errors} failed — ${usd(t.cost)}`);
  return t;
}

async function waitFor(api, batchId, log) {
  for (;;) {
    const b = await api.messages.batches.retrieve(batchId);
    if (b.processing_status === "ended") return;
    const c = b.request_counts ?? {};
    log(`  ${b.processing_status}: ${n(c.succeeded ?? 0)} done, ${n(c.processing ?? 0)} running`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * label({platform, chats, dryRun, budget, confirm}) — confirm(text) resolves
 * to true to go ahead; the CLI asks the user.
 */
export async function label({ platform, chats, dryRun = false, budget = null, confirm = async () => false, log = console.log, api: injected = null }) {
  loadEnv();
  if (!chats?.length) throw new Error("name at least one chat: --chat <id> (find ids with `chatkit chats`).");
  const E = await engine(platform);
  for (const c of chats) if (!E.db.getChat(c)) throw new Error(`no ${platform} chat ${c} — \`chatkit chats ${platform}\` lists them.`);

  // A batch from an earlier run that never got read back: read it first.
  const open = E.index.openBatches();
  if (open.length && !dryRun) {
    const api = injected ?? (await client());
    for (const b of open) {
      log(`picking up batch ${b.id} from an earlier run`);
      await waitFor(api, b.id, log);
      await collect(E, api, b.id, log);
    }
  }

  const { requests, secret, ceiling } = plan(E, chats);
  const names = chats.map((c) => E.plat.chatName(c) ?? c).join(", ");
  log(`\n${platform} · ${names}`);
  log(`  ${n(requests.length)} conversations need a label`);
  if (secret.length) log(`  ${secret.length} left out: they look like they hold a password or key, so they are never sent`);
  log(`  cost ceiling ${usd(ceiling)} (${MODEL}, Batch API; usually well under this)`);
  if (!requests.length) return { labelled: 0, cost: 0 };
  if (dryRun) {
    log("  dry run: nothing was sent.\n");
    return { labelled: 0, cost: 0, ceiling, count: requests.length };
  }
  if (budget !== null && ceiling > budget) {
    throw new Error(`the ceiling ${usd(ceiling)} is above your budget ${usd(budget)}. Raise --budget or label fewer chats.`);
  }
  if (!(await confirm(`Send ${n(requests.length)} conversations from ${names} to Anthropic for labelling, up to ${usd(ceiling)}?`))) {
    log("  cancelled: nothing was sent.");
    return { labelled: 0, cost: 0 };
  }

  const api = injected ?? (await client());
  let labelled = 0;
  let cost = 0;
  for (let i = 0; i < requests.length; i += CHUNK) {
    const part = requests.slice(i, i + CHUNK);
    const batch = await api.messages.batches.create({ requests: part });
    E.index.recordBatch(batch.id, { n_requests: part.length, stage: `chatkit ${MODEL}` });
    log(`  submitted batch ${batch.id} (${n(part.length)} conversations) — usually done within the hour`);
    await waitFor(api, batch.id, log);
    const t = await collect(E, api, batch.id, log);
    labelled += t.saved;
    cost += t.cost;
  }
  log(`\ndone: ${n(labelled)} conversations labelled for ${usd(cost)}.\n`);
  return { labelled, cost };
}

// For `chatkit chats`: every chat with its size and how much is labelled.
export async function chatList(platform, { query = null, limit = 40 } = {}) {
  const E = await engine(platform);
  const rows = E.index
    .indexDb()
    .prepare(
      `SELECT chat_jid, COUNT(*) AS conversations, SUM(n_messages) AS messages,
              SUM(topic IS NOT NULL) AS labelled, MAX(ended_at) AS last
         FROM episodes GROUP BY chat_jid ORDER BY messages DESC`
    )
    .all();
  const q = query?.toLowerCase();
  return rows
    .map((r) => ({ ...r, name: E.plat.chatName(r.chat_jid) ?? r.chat_jid }))
    .filter((r) => !q || String(r.name).toLowerCase().includes(q) || r.chat_jid.includes(q))
    .slice(0, limit);
}
