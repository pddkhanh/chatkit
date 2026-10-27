# Setting up chatkit for the user (instructions for the coding agent)

You are a coding agent (Claude Code, Codex, or similar) opened in this repo. The
user wants chatkit set up so that you, in later sessions, can search their own
WhatsApp and/or Telegram history. Walk them through it: run every step you can
yourself, and hand the few interactive steps to them.

## Rules

- **Never read** `data/` (their messages and sessions) or `.env` (their keys) with
  file or shell tools. Use `chatkit status` to see what is set up.
- **Never ask the user to paste a key, password, phone code or 2FA password into
  this chat.** Keys go in through `chatkit key …`, which the user runs in their own
  terminal (hidden input). If they paste one anyway, tell them to revoke it.
- **Labelling costs money.** Only run `chatkit label` without `--dry-run` after the
  user has seen the dry-run count and price ceiling and said yes. Pass the
  `--budget` they agree to, and `--yes` only then.
- chatkit is read-only. Do not add, enable or write code that sends messages.
- Do not delete `data/whatsapp/store` or `data/telegram/session`: WhatsApp history
  is only sent once, at linking.

## Steps

**0. Check the machine.** Run `./install.sh`. It needs Node 22+, and for WhatsApp
also Go and the Xcode command line tools. If something is missing, tell the user
the exact command (`brew install node go`, `xcode-select --install`) and wait.
If `chatkit` is not on PATH afterwards, use `node bin/chatkit.js` instead below.

**1. Ask which platform**: WhatsApp, Telegram, or both. Ask how their own
messages should be named (default "Me"), then run `chatkit owner "<name>"`.

**2. Link each account. These are interactive: the user runs them in a separate
Terminal window** (`cd` to this folder first; if `chatkit` is not on PATH, use
`node bin/chatkit.js`). Do not run `chatkit link` or `chatkit key` yourself, and
not through a `!` shell inside the agent either: they wait for typed input or a
phone scan. Tell the user what to expect, give them the exact command, then wait
for them to say it finished.

- WhatsApp: `chatkit link wa`. A QR code appears; on the phone: WhatsApp →
  Settings → Linked devices → Link a device, and scan it. About a year of history
  then arrives, once. The command stops by itself a few minutes after history
  stops arriving; tell them not to interrupt it.
- Telegram: first an API id and hash of their own: https://my.telegram.org → log
  in → API development tools → create an app (any name, platform Desktop). Then
  `chatkit link tg` asks for the api_id and api_hash (hidden), their phone number,
  the code Telegram sends, and the 2FA password if they have one. It then pulls
  the whole history, which can take a while for a big account.

Afterwards run `chatkit status` and confirm the platform shows as linked.

**3. Ask how new messages should arrive**, per platform:

- On demand: nothing to start. They (or you) run `chatkit pull` when they want new
  messages. For WhatsApp, tell them to pull at least every two or three weeks, or
  WhatsApp logs out the linked device.
- Live: `chatkit service start wa` / `chatkit service start tg`. A background
  service keeps it current and restarts at login. `chatkit service logs wa` shows
  how it is doing.

**4. Build the search index**: `chatkit index`. Free, local, seconds to minutes.

**5. Offer labels (optional).** Explain: labels give each conversation an English
topic, who it is about, people, keywords and facts, which makes search much better,
especially for chats in other languages. It needs their own Anthropic API key and
sends the text of the chosen chats to Anthropic; it costs roughly $0.002–0.003 per
conversation. If they want it:

1. They run `chatkit key anthropic` in their separate Terminal window (hidden input).
2. You run `chatkit chats wa` (or `tg`) and ask which chats matter to them.
3. You run `chatkit label wa --chat <id>[,<id>] --dry-run` and show them the count
   and the price ceiling.
4. Only on their yes: `chatkit label wa --chat <ids> --budget <their number> --yes`.
   It submits a batch and waits for it (usually under an hour); you can leave it
   running and check back. Re-running later only labels what is new.

**6. Optional meaning search**: `chatkit embed setup` installs llama.cpp and a
~640 MB model and embeds every conversation locally. Ask before running it.

**7. Register the search tools** with the agent(s) they use:
`chatkit mcp add claude` and/or `chatkit mcp add codex` (add `wa` or `tg` to limit
it to one platform). Anything else: `chatkit mcp show` prints the configuration.
Tell them to start a new session for the tools to appear, and suggest a first
question, for example: "search my WhatsApp for what we decided about the trip".

## Using it later

With the tools registered, answer questions about their chats with
`search_messages` (whole conversations, best first), open one with
`get_conversation`, read a period with `get_recent_messages`, and find photos,
files and links with `find_media`. `list_chats` and `search_contacts` give ids and
names. Quote what the messages actually say; if the search finds nothing, say so.
