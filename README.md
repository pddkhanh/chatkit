# chatkit

Search your own WhatsApp and Telegram history from Claude Code or Codex.

Ask your agent *"what did Minh say about the trip in March?"* and it searches your
chats, reads whole conversations, and answers with the messages it found.

- **Local.** Your messages stay on your Mac, in `./data`.
- **Read-only.** chatkit never sends a message. The WhatsApp bridge it builds has no
  send code at all, and the Telegram mirror only receives.
- **Good search.** Results are whole conversations, not single lines. Accents and
  Vietnamese teen code are ignored (`dam cuoi` finds *đám cưới*, `ko` finds *không*).
  Optional labels and local meaning search let an English question find a
  conversation in another language.

## Install

You need macOS, [Node 22+](https://nodejs.org) and, for WhatsApp, Go and the Xcode
command line tools (`brew install node go`, `xcode-select --install`).

```bash
git clone https://github.com/pddkhanh/chatkit.git ~/chatkit
cd ~/chatkit
./install.sh
chatkit setup
```

## What `chatkit setup` asks

1. **Platform**: WhatsApp, Telegram, or both.
2. **Link your account.**
   - *WhatsApp*: scan a QR code from your phone (Settings → Linked devices → Link a
     device). WhatsApp then sends **about one year of history, once, at linking**.
     Leave it running until it stops by itself.
   - *Telegram*: create your own API id and hash at
     [my.telegram.org](https://my.telegram.org) (API development tools), then log in
     with the code Telegram sends you. chatkit then pulls your whole history.
3. **Updates**: *on demand* (run `chatkit pull` when you want new messages) or
   *live* (a background service keeps it up to date and restarts at login).
4. **Search index**: built automatically. Free and local.
5. **Labels (optional)**: label past conversations of the chats you pick, with your
   own Anthropic API key. See below.
6. **Connect your agent**: chatkit registers its search tools with Claude Code or
   Codex for you (as `whatsapp` / `telegram`, or `chatkit-whatsapp` if that name is
   already taken by another server), or prints the configuration to paste.

## Labels: better search, on your API key

A label is a short English header for each conversation: its topic, who it is
about, whether it is a joke / fact / plan / gossip, the people in it, search
keywords and concrete facts. Search matches labels too, so `flowers` finds a
Vietnamese thread that never uses the word, and `about=Minh` finds conversations
*about* Minh, not just ones he typed in.

```bash
chatkit chats wa                                   # find a chat id
chatkit label wa --chat 1203630xxxxx@g.us --dry-run  # count + price ceiling, sends nothing
chatkit label wa --chat 1203630xxxxx@g.us --budget 5
```

- You always name the chats. There is no "label everything".
- The dry run is free and prints a **price ceiling**. The real bill is usually
  around $0.002–0.003 per conversation (Claude Sonnet on the Batch API); one busy
  chat with a friend is typically a few thousand conversations, so a few dollars.
- A conversation that looks like it contains a password or API key is never sent.
- Labelling sends the text of the chosen chats to Anthropic under your API key.
  Nothing else ever leaves your Mac.
- Re-running only labels conversations that do not have a label yet.

## Commands

```
chatkit setup                         the guided setup
chatkit status                        what is linked, running, and stored
chatkit link <wa|tg>                  link an account
chatkit pull [wa|tg]                  fetch new messages now
chatkit service start|stop|logs <wa|tg>   live updates in the background
chatkit chats <wa|tg> [name]          list chats with ids and sizes
chatkit label <wa|tg> --chat <id>[,<id>] [--dry-run] [--budget <usd>] [--yes]
chatkit mcp add [claude|codex] [wa|tg]    give an agent the search tools
chatkit mcp show                      print the MCP configuration
chatkit embed setup                   optional: local meaning search (~640 MB model)
```

The agent gets these tools: `search_messages`, `get_conversation`,
`get_recent_messages`, `get_message_context`, `find_media`, `get_chat_members`,
`list_chats`, `search_contacts` (and `find_links` on Telegram). No send tools.

## Things to know

- **WhatsApp history comes once.** It arrives only when the device is first linked.
  If you delete `data/whatsapp/store` or unlink the device, you have to link again,
  and you get whatever WhatsApp sends at that time.
- **One copy per account.** Never copy `data/whatsapp/store` or
  `data/telegram/session` to a second machine and run both: that can get the device
  logged out. chatkit also refuses to `pull` while the live service is running.
- **On-demand WhatsApp**: pull at least every two or three weeks. WhatsApp logs out
  a linked device that is unused for about a month.
- **Unofficial clients.** chatkit uses [whatsmeow](https://github.com/tulir/whatsmeow)
  (WhatsApp Web protocol) and [teleproto](https://www.npmjs.com/package/teleproto)
  (Telegram MTProto). WhatsApp and Telegram can restrict accounts that use
  third-party clients. A read-only mirror is low risk, but not zero.
- **Your secrets**: `data/whatsapp/store/whatsapp.db` and `data/telegram/session`
  are as powerful as your phone's login. `.env` holds your API keys. All three are
  git-ignored. Do not put this folder in a cloud drive.

## How it works

```
WhatsApp ──► whatsapp/bridge (Go, whatsmeow) ──► data/whatsapp/store/messages.db ─┐
Telegram ──► telegram/ingest (Node, teleproto) ──► data/telegram/messages.db ─────┤
                                                                                   ▼
                                               <platform>/engine: search.db (SQLite FTS,
                                               conversations, labels, vectors)
                                                                                   ▼
                                          lib/mcp.js (stdio) ──► Claude Code / Codex
```

Messages are grouped into conversations by time gaps. Search runs on words
(accent-folded, teen-code aware), on labels, and, when meaning search is on, on a
local embedding of each conversation; the results are merged and returned as whole
conversations.

`people` aliases in `<platform>/config.json` let several names point at one person,
for example `{"people": {"*": [{"name": "Minh", "aliases": ["Minh", "a Minh", "Minh Tran"]}]}}`.

## Credits

The WhatsApp bridge started from [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp)
(MIT). chatkit removed its sending, added edit/delete/poll tracking, a fuller history
request and an on-demand mode.

MIT licence.
