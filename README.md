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

The plugin ships the `/discord-threads:access` skill for managing the allowlist
from your terminal. That skill only edits JSON and opens **no** Discord
connection, so installing it in interactive sessions is free.

The daemon is separate and runs as a `systemd --user` service. Disable the
official `discord` plugin first, or you will keep a second gateway login.

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
