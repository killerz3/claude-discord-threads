# discord-threads

A Discord channel for Claude Code where **each conversation is a thread** and
**delivery is guaranteed by a daemon rather than remembered by the model**.

> **This is a modified fork.** It derives from `external_plugins/discord` in
> [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official),
> Apache-2.0. See [What changed](#what-changed-vs-the-official-plugin).

## Why

The official plugin registers an MCP server that relays Discord messages into a
Claude Code session and asks the model, in prose, to call a `reply` tool. That
produces three problems:

1. **Missed replies.** Replying is a model decision. If a turn ends without the
   tool call, the message is silently never answered.
2. **No isolation.** Every Discord conversation lands in one session, so
   unrelated topics share a context window and get compacted away together.
3. **A gateway per session.** `.mcp.json` is plugin-scoped, so *every* Claude
   Code session — including every interactive SSH session — spawns the server
   and opens its own Discord gateway login on the same bot token.

And nothing is durable: if the session is down when a message arrives, the
notification fails, the error goes to stderr, and the message is gone.

## How this fixes it

Ownership is inverted. A single daemon owns the Discord connection and the turn
lifecycle; Claude Code becomes a worker it drives.

```
ccdiscordd — one process, systemd --user
  │
  ├── discord.js Client ......... the only gateway login on this token
  ├── access gate ............... ported from the official server.ts
  ├── SQLite (bun:sqlite) ....... threads · turns · watermarks · permissions
  ├── turn state machine ........ owns delivery, survives crashes
  └── worker pool ............... Claude Agent SDK, bounded concurrency
        ├── thread A → its own Claude Code session
        └── thread B → its own Claude Code session
```

### Delivery is an invariant, not an instruction

**Workers have no `reply` tool.** The model's ordinary final answer *is* the
Discord message: the daemon reads `result` off the SDK's `SDKResultMessage` and
posts it. There is nothing left to forget.

Every inbound message becomes a persisted row advancing through:

```
queued → seen(👀) → running(⏳) → delivering → done(✅)
                                            ↘ failed(❌) → retry/backoff
```

- The row is written **before** the model runs.
- `done` is set only after Discord confirms a message ID.
- On boot, non-terminal rows are replayed; a row that already has
  `reply_message_ids` reconciles to `done` instead of re-sending, so recovery
  delivers **exactly once**.
- On boot the daemon also fetches messages after each channel's stored
  watermark, so messages that arrived while it was down are still answered.
- Rate-limit errors never drop a turn: it returns to `queued` with backoff.

### Signals

| Signal | Fires when |
|---|---|
| 👀 | the access gate accepted the message |
| ⏳ | a worker picked the turn up (plus a refreshed typing indicator) |
| live status | edited in place as tool calls happen |
| ✅ | Discord confirmed the reply |
| ❌ | error, timeout, or denial |
| 🔐 | a tool needs approval — Allow/Deny buttons, turn blocks |

## What changed vs. the official plugin

| | Official `discord` | This fork |
|---|---|---|
| Transport owner | one MCP server **per Claude Code session** | one daemon |
| Gateway logins | one per session (3 concurrent is typical) | exactly one |
| Reply | model calls a `reply` tool, may forget | daemon posts the turn result |
| Conversations | all share one session | one session per Discord thread |
| If the host is down | message lost | replayed from a watermark |
| Crash mid-turn | reply lost | replayed, delivered exactly once |
| `.mcp.json` | registers `server.ts` | **removed** — no per-session server |

Carried over unchanged, because it is already well hardened: the access gate and
pairing flow, `assertSendable` (blocks exfiltrating the channel state dir),
`safeAttName` and the 2000-char chunker, the permission-reply grammar and button
handler, and attachment download into `inbox/`.

## Install

Two halves with opposite lifecycles: a skill you install into Claude Code, and a
daemon that runs on its own.

**1. Disable the official plugin.** Leave it on and every Claude Code session
opens its own gateway login on the same token — the bug this fork exists to fix.

```jsonc
// ~/.claude/settings.json
"enabledPlugins": { "discord@claude-plugins-official": false }
```

**2. Point the token at the daemon.** Nothing moves if you already ran the
official plugin; it reads the same files.

```bash
mkdir -p ~/.claude/channels/discord
printf 'DISCORD_BOT_TOKEN=%s\n' "$TOKEN" > ~/.claude/channels/discord/.env
chmod 600 ~/.claude/channels/discord/.env
```

**3. Install dependencies.**

```bash
cd external_plugins/discord-threads && bun install
```

**4. Run the daemon.** Check it in the foreground first — it refuses to start
twice, so this is safe even if a copy is already running:

```bash
bun run src/daemon.ts          # expect "gateway connected as <bot>"
DISCORD_RESPONDER=echo bun run src/daemon.ts   # pipeline test, no model tokens
```

Then install the service (edit the two paths in the unit if your checkout is
elsewhere):

```bash
cp systemd/discord-threads.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now discord-threads
journalctl --user -u discord-threads -f
```

`loginctl enable-linger $USER` keeps it running when you are logged out.

**5. Opt a channel in**, from your own terminal — never in response to a Discord
message:

```
/discord-threads:access group add <channel-id> --no-mention
```

## Thread commands

Handled by the daemon, never by the model, so they cost nothing and always
answer.

| Thread | |
|---|---|
| `/help` | the list |
| `/status` | session, model, directory, turn counts |
| `/cwd [path]` | show or change this thread's working directory |
| `/clear` | forget the conversation, keep the thread |
| `/stop` | cancel the turn that is running |
| `/done` | archive the thread |

| Claude | |
|---|---|
| `/usage` | plan limits — 5-hour and weekly windows, with reset times |
| `/cost` | what this thread has spent |
| `/context` | context window used by this conversation |
| `/model [name]` | show, list or set the model for this thread |
| `/permissions [mode]` | show or set the permission mode |
| `/compact` | summarise the conversation to free up context — **costs tokens** |

| Elsewhere | |
|---|---|
| `/threads` | every open thread |

`/usage`, `/context` and `/model` read the same structured data as Claude
Code's own slash commands, through SDK **control requests**: the daemon opens a
session whose prompt stream never yields, asks its question, and closes. The CLI
boots but no turn is ever submitted, so these spend no tokens. Results are
cached briefly because each call costs a process spawn.

`/compact` is the exception to "free": it is a real summarisation call. It is
also the one command the daemon does *not* implement — Claude Code's CLI
intercepts it before the model, so the daemon just lets it through. Compaction
completes with an empty result, which would otherwise post an error for a
command that worked, so the daemon reports the boundary event instead:

```
🗜️ Compacted this conversation. 15,867 → 1,922 tokens (13,945 dropped). Took 12.3s.
```

Commands that are inherently interactive or terminal-bound — `/config`, `/vim`,
`/doctor`, `/login`, `/resume` — have no sensible Discord translation and are
deliberately absent. `bypassPermissions` is not offered to `/permissions`:
granting it from a chat message would remove the approval path the buttons exist
to provide.

Anything else is a message for Claude. An unrecognised `/word` is treated as
prose rather than rejected.

## Configuration

Environment variables, all optional:

| | |
|---|---|
| `DISCORD_MAX_WORKERS` | concurrent turns (default 3) |
| `DISCORD_PERMISSION_MODE` | worker permission mode (default `auto`) |
| `DISCORD_PERMISSION_TIMEOUT_MS` | how long a prompt waits for a button (default 5 min) |
| `DISCORD_THREAD_IDLE_MS` | archive a thread after this long idle (default 24h) |
| `DISCORD_WORKER_CWD` | default working directory for new threads |
| `DISCORD_RESPONDER=echo` | echo instead of calling the model |
| `DISCORD_LOG_LEVEL` / `DISCORD_LOG_JSON` | `debug`–`error`; `1` for JSON lines |

`auto` is the mode Claude Code's own interactive sessions use: a classifier
approves routine calls and escalates the rest to the Discord buttons. The
stricter `default` prompts on every Bash call, which in practice means several
buttons per question.

## Configuration

State stays where the official plugin puts it, so no migration is needed:

| Path | Contents |
|---|---|
| `~/.claude/channels/discord/.env` | `DISCORD_BOT_TOKEN` (mode 600, **never** in this repo) |
| `~/.claude/channels/discord/access.json` | policy, allowlist, groups, pairing |
| `~/.claude/channels/discord/threads.db` | thread ↔ session map, turn ledger |
| `~/.claude/channels/discord/inbox/` | downloaded attachments |

## Single-user by design

Anthropic's Agent SDK terms do not permit offering claude.ai logins or rate
limits to third parties without prior approval. A bot that lets *other people*
send prompts through your subscription is exactly that. Keep `allowFrom` to your
own account. The access skill will not widen it without an explicit override.

## Bot permissions

The bot needs `VIEW_CHANNEL`, `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`,
`CREATE_PUBLIC_THREADS`, `READ_MESSAGE_HISTORY`, `ADD_REACTIONS`,
`ATTACH_FILES`, and `MANAGE_THREADS` (for archiving and locking).

## License

Apache-2.0, inherited from the upstream project. See `LICENSE`.
