#!/usr/bin/env node
// chatkit — the MCP server an agent (Claude Code, Codex) talks to over stdio.
//   node lib/mcp.js whatsapp | telegram
//
// Read-only by construction: the tools it mounts only read the local message
// store and the search index. Nothing here can send a message.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { stores, PLATFORMS } from "./paths.js";

loadEnv();
const platform = process.argv[2];
// stdout is the MCP transport; diagnostics go to stderr.
const log = (...a) => console.error(`[chatkit-${platform}]`, ...a);

if (!PLATFORMS.includes(platform)) {
  log(`usage: node lib/mcp.js ${PLATFORMS.join(" | ")}`);
  process.exit(2);
}
const s = stores(platform);
if (!fs.existsSync(s.messages)) {
  log(`no messages yet at ${s.messages} — run \`chatkit setup\` first`);
  process.exit(1);
}

const db = await import(`../${platform}/engine/db.js`);
const index = await import(`../${platform}/engine/searchindex.js`);
const { buildTools } = await import(`../${platform}/engine/tools.js`);

db.configureDb(s.messages);
index.configureSearch(s.messages, s.search);
try {
  const r = index.sync();
  if (r?.added) log(`indexed ${r.added} new message(s)`);
} catch (err) {
  log(`index sync failed (${err?.message ?? err}) — serving what is already indexed`);
}

const server = new McpServer({ name: platform, version: "1.0.0" });
for (const t of buildTools({})) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args) => {
    try {
      return { content: [{ type: "text", text: String(await t.handler(args ?? {})) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `error: ${err?.message ?? err}` }], isError: true };
    }
  });
}
await server.connect(new StdioServerTransport());
log("ready");
