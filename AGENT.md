# AGENT.md — install and set up discord-threads

This file is written for an AI agent (Claude Code, or any agent with a shell)
that has been told:

> Follow the AGENT.md in https://github.com/killerz3/claude-discord-threads and install and setup

Work through the phases in order. Each step is marked either **AUTO** (do it,
no need to ask) or **ASK** (you cannot know the answer; stop and ask the user,
then continue). Verify every step before moving on. Never invent credentials,
IDs or tokens. Never print a token back to the user once you have it.

What you are installing: a background daemon (a `systemd --user` unit on
Linux, a LaunchAgent on macOS) that holds one Discord gateway connection, opens a Discord thread per conversation, and drives one
Claude Code session per thread. The daemon owns reply delivery, so nothing is
lost across crashes or restarts.

---

## Phase 0 — Preconditions (AUTO, then ASK only on failure)

Check all of these. Fix what you can; ask the user about the rest.

| Requirement | How to check | If missing |
|---|---|---|
| A host that stays on | `uname -s` → `Linux` or `Darwin` | Windows: ASK the user to install WSL2 (Ubuntu) and run everything inside it; it has `systemd --user`. Native Windows is not supported. |
| Linux: `systemd --user` | `systemctl --user status` exits 0 | ASK: the host has no user systemd. Offer to run in the foreground only. |
| macOS: stays awake and logged in | `pmset -g \| grep -E ' sleep'` | A LaunchAgent runs only in a logged-in session. ASK the user whether you may run `sudo pmset -a sleep 0 disksleep 0` (desktop / Mac mini) and enable automatic login. A laptop with the lid closed will not answer unless it is on power with an external display. |
| `git` | `git --version` | AUTO: install with the system package manager. |
| Bun ≥ 1.1 | `~/.bun/bin/bun --version` or `bun --version` | AUTO: `curl -fsSL https://bun.sh/install \| bash`, then re-check. On macOS `brew install oven-sh/bun/bun` is fine too, but then Bun is at `/opt/homebrew/bin/bun`. Note the absolute path; the service files assume `~/.bun/bin/bun`. |
| Claude Code, authenticated | `claude --version`; then `claude -p "say ok" --max-turns 1` returns text | ASK: the user must log in themselves (`claude` then `/login`) **or** tell you to use an API key. Do not choose for them. If they give an API key, put `ANTHROPIC_API_KEY=…` in the `.env` file from Phase 2, never in the unit file. |
| Cloudflare / firewall | none | Outbound HTTPS only. No inbound ports are needed. |

Record the OS, the Bun path and the user's home directory; you need all three later.

---

## Phase 1 — The Discord application (ASK; the user does this in a browser)

You cannot do this part. Send the user these instructions verbatim, then wait
for the **bot token** and, after the invite, the **channel ID**.

1. Open https://discord.com/developers/applications → **New Application**. Name it anything.
2. **Bot** tab:
   - **Reset Token** → copy it. It is shown once. Paste it back to me.
   - Under **Privileged Gateway Intents** enable **Message Content Intent**. Required; without it the bot sees empty messages.
   - Turn **Public Bot** off unless you want other people to be able to add it to servers.
3. **OAuth2 → URL Generator**:
   - Scopes: `bot` and `applications.commands`.
   - Bot permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Attach Files, Manage Threads.
   - Or use this URL directly, replacing `CLIENT_ID` with the Application ID from **General Information**:
     ```
     https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=326417615936
     ```
   - Open the URL and add the bot to your server.
4. In Discord: **User Settings → Advanced → Developer Mode** on. Then right-click the channel the bot should answer in → **Copy Channel ID**, and right-click your own avatar → **Copy User ID**. Send me both.

Collect from the user, in this order:

- `DISCORD_BOT_TOKEN` (long string, usually starts `MT` or `Nz`)
- the **channel ID** (numeric snowflake, 17–20 digits)
- the user's own **Discord user ID** (numeric snowflake). If they cannot find it, pairing in Phase 6 will capture it; do not block on it.

Validate shape: token has two dots, IDs are all digits. If not, ask again.

---

## Phase 2 — Token and state directory (AUTO)

The daemon reads the same directory the official Discord plugin uses, so an
existing install keeps working.

```bash
mkdir -p ~/.claude/channels/discord
umask 077
printf 'DISCORD_BOT_TOKEN=%s\n' "$TOKEN" > ~/.claude/channels/discord/.env
chmod 600 ~/.claude/channels/discord/.env
```

If the user chose an API key in Phase 0, append `ANTHROPIC_API_KEY=…` to the
same file. Verify with `ls -l` that the mode is `-rw-------`. Do not `cat` the file.

---

## Phase 3 — Disable the official plugin (AUTO)

If `discord@claude-plugins-official` is enabled, every Claude Code session opens
its own gateway login on the same token and answers messages twice. Edit
`~/.claude/settings.json` (create it if absent, keep everything else intact):

```json
{ "enabledPlugins": { "discord@claude-plugins-official": false } }
```

Merge into the existing `enabledPlugins` object; do not overwrite other keys.
Verify the file is still valid JSON (`python3 -m json.tool` or `jq .`).

---

## Phase 4 — Get the code (AUTO; ASK only if the default path is taken)

Default checkout is `~/claude-discord-threads`. The unit file assumes it. If that
path already exists and is not this repo, ASK where to put it.

```bash
git clone https://github.com/killerz3/claude-discord-threads ~/claude-discord-threads
cd ~/claude-discord-threads
~/.bun/bin/bun install
```

Verify: `ls node_modules/discord.js node_modules/@anthropic-ai/claude-agent-sdk` both exist.

---

## Phase 5 — Access policy (AUTO from what you collected)

Write `~/.claude/channels/discord/access.json`. The daemon re-reads it on every
message, so no restart is needed later. Fill in the IDs from Phase 1:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<USER_ID>"],
  "groups": {
    "<CHANNEL_ID>": { "requireMention": false, "allowFrom": [] }
  },
  "pending": {},
  "mentionPatterns": []
}
```

Rules:

- If you have the user's ID → `dmPolicy: "allowlist"`, as above. This is the locked state.
- If you do **not** have it → `dmPolicy: "pairing"` and `allowFrom: []`. Phase 6 captures the ID; you switch to `allowlist` afterwards.
- `requireMention: false` means every message in that channel starts a thread. If the channel is shared with other people, ASK whether they want `true` (only when @mentioned).
- Keep `allowFrom` to the user's own account. Anthropic's Agent SDK terms do not allow sharing a claude.ai subscription with third parties. Do not add other people unless the user explicitly insists, and say why you are hesitant.

---

## Phase 6 — First run in the foreground (AUTO)

Exercise the pipeline without spending tokens first:

```bash
cd ~/claude-discord-threads
DISCORD_RESPONDER=echo timeout 60 ~/.bun/bin/bun run src/daemon.ts
```

Expected within a few seconds:

```
discord-threads: gateway connected as=<BotName>#1234 maxConcurrentTurns=3
discord-threads: recovery complete replayed=0 ...
```

Then ask the user to post `hello` in the channel. The bot should react 👀 → ⏳ →
open a thread → echo the text back → ✅. If it does:

- Ctrl-C / let the timeout end. The daemon refuses to start twice, so a
  leftover copy will print `already running` rather than double-answer.

Failure map:

| Symptom | Cause | Fix |
|---|---|---|
| `DISCORD_BOT_TOKEN required` | `.env` missing or malformed | redo Phase 2 |
| `Used disallowed intents` | Message Content Intent off | user enables it in the Bot tab |
| connected, but no reaction to messages | wrong channel ID, or `requireMention: true` and no @mention | check `access.json`; try @mentioning the bot |
| bot replies with a 6-char pairing code in DM | pairing mode, user not allowlisted | read `pending.<code>.senderId` from `access.json`, add it to `allowFrom`, set `dmPolicy` to `allowlist`, delete the `pending` entry |
| `Missing Permissions` on thread creation | bot invited without Create Public Threads / Manage Threads | re-invite with the URL from Phase 1 |
| worker fails immediately with an auth error | Claude Code not logged in | Phase 0 |

If pairing was used: the sender's snowflake is written to `access.json` under
`pending.<code>.senderId`. Move it into `allowFrom`, set `dmPolicy` to
`allowlist`, clear `pending`, and tell the user you locked it down.

Now do one real turn: run without `DISCORD_RESPONDER` for one message and
confirm a model answer lands with ✅. This costs a few tokens; say so.

---

## Phase 7 — Install as a service (AUTO; pick the branch for the OS)

### Linux (systemd --user)

```bash
mkdir -p ~/.config/systemd/user
cp ~/claude-discord-threads/systemd/discord-threads.service ~/.config/systemd/user/
```

Edit the copied unit **only if** the checkout is not at `~/claude-discord-threads`
or Bun is not at `~/.bun/bin/bun` (`WorkingDirectory=` and `ExecStart=`). Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now discord-threads
loginctl enable-linger "$USER"      # keeps it running after logout; may prompt for sudo on some hosts
```

Verify:

```bash
systemctl --user is-active discord-threads     # active
journalctl --user -u discord-threads -n 20 --no-pager | grep 'gateway connected'
```

If `loginctl enable-linger` needs root and you do not have it, ASK the user to
run it. Without linger the daemon stops when their last SSH session ends.

### macOS (LaunchAgent)

launchd does not expand `~`, so the plist carries a `__HOME__` placeholder that
you substitute on copy:

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
sed "s|__HOME__|$HOME|g" ~/claude-discord-threads/launchd/dev.killerz3.discord-threads.plist \
  > ~/Library/LaunchAgents/dev.killerz3.discord-threads.plist
```

Edit the copied plist **only if** Bun is not at `~/.bun/bin/bun` (first
`ProgramArguments` entry; Homebrew puts it at `/opt/homebrew/bin/bun`) or the
checkout is not at `~/claude-discord-threads` (`WorkingDirectory`). Then:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.killerz3.discord-threads.plist
```

Verify:

```bash
launchctl print gui/$(id -u)/dev.killerz3.discord-threads | grep -E 'state|pid'   # state = running
sleep 5; grep 'gateway connected' ~/Library/Logs/discord-threads.log | tail -1
```

Useful later: `launchctl kickstart -k gui/$(id -u)/dev.killerz3.discord-threads`
restarts it; `launchctl bootout gui/$(id -u)/dev.killerz3.discord-threads` stops
and unloads it. It starts again at every login (`RunAtLoad`) and after any
crash (`KeepAlive`).

The agent runs in the user's login session: if they log out, it stops. Remind
them of the sleep / auto-login answer from Phase 0.

---

## Phase 8 — Skills in the user's own Claude Code (ASK; user types these)

Two slash commands, `/discord-threads:access` and `/discord-threads:configure`,
manage the allowlist from the user's terminal. They are installed by the user,
inside an interactive Claude Code session, not by you:

```
/plugin marketplace add killerz3/claude-discord-threads
/plugin install discord-threads@claude-discord-threads
```

This is optional. Everything the skills do is editing `access.json`, which you
have already written. Tell the user this and move on; do not block on it.

---

## Phase 9 — Optional tuning (ASK once, all in one question)

Ask the user one question covering the defaults below. If they say "defaults",
change nothing.

| Variable | Default | Ask |
|---|---|---|
| `DISCORD_WORKER_CWD` | the home directory | "Which directory should new threads start in?" |
| `DISCORD_MAX_WORKERS` | 3 | "How many conversations may run at once?" Each is a Claude Code process (~400 MB) and shares the account rate limit. |
| `DISCORD_PERMISSION_MODE` | `auto` | "Should routine tool calls be auto-approved (`auto`) or should every Bash call ask (`default`)?" |
| `DISCORD_THREAD_IDLE_MS` | 24 h | "Archive idle threads after how long?" |

Set any changes as `Environment=` lines in the `[Service]` section of the unit
file on Linux, or as entries in the `EnvironmentVariables` dict of the plist on
macOS (never in `.env` unless it is a secret). Then reload: `daemon-reload` and
`restart` on Linux; `bootout` then `bootstrap` on macOS.
The model for new threads is set from Discord with `/model global <name>`, not
here.

---

## Phase 10 — Hand-off (AUTO)

Tell the user, in this order, without printing any token:

1. The daemon is running: as `discord-threads` under their user systemd on Linux, surviving reboots if linger is on; or as the `dev.killerz3.discord-threads` LaunchAgent on macOS, starting at every login.
2. Which channel is opted in, and whether every message or only @mentions start a thread.
3. Who is allowed (`allowFrom`), and that pairing is off.
4. The commands they can type in a thread: `/help`, `/status`, `/model`, `/usage`, `/cost`, `/context`, `/permissions`, `/cwd`, `/clear`, `/stop`, `/done`, `/compact`, and `/threads` anywhere.
5. How to watch and stop it. Linux: `journalctl --user -u discord-threads -f` and `systemctl --user stop discord-threads`. macOS: `tail -f ~/Library/Logs/discord-threads.log` and `launchctl bootout gui/$(id -u)/dev.killerz3.discord-threads`.
6. One warning: never re-enable `discord@claude-plugins-official` while the daemon runs.

---

## Reference

| Path | Contents |
|---|---|
| `~/.claude/channels/discord/.env` | `DISCORD_BOT_TOKEN`, optional `ANTHROPIC_API_KEY`; mode 600 |
| `~/.claude/channels/discord/access.json` | policy, allowlist, opted-in channels |
| `~/.claude/channels/discord/threads.db` | thread ↔ session map, turn ledger |
| `~/.claude/channels/discord/inbox/` | downloaded attachments |
| `~/.claude/channels/discord/daemon.lock` | single-instance lock |
| `~/.config/systemd/user/discord-threads.service` | the unit (Linux) |
| `~/Library/LaunchAgents/dev.killerz3.discord-threads.plist` | the LaunchAgent (macOS) |
| `~/Library/Logs/discord-threads.log` | daemon log (macOS; Linux uses the journal) |

Environment variables the daemon reads: `DISCORD_BOT_TOKEN`, `DISCORD_MAX_WORKERS`,
`DISCORD_PERMISSION_MODE`, `DISCORD_PERMISSION_TIMEOUT_MS`, `DISCORD_THREAD_IDLE_MS`,
`DISCORD_WORKER_CWD`, `DISCORD_RESPONDER`, `DISCORD_LOG_LEVEL`, `DISCORD_LOG_JSON`,
`DISCORD_STATE_DIR`, `DISCORD_DB_FILE`, `DISCORD_LOCK_FILE`.

Uninstall: `systemctl --user disable --now discord-threads` and remove the unit
(Linux), or `launchctl bootout gui/$(id -u)/dev.killerz3.discord-threads` and
remove the plist (macOS); then remove the checkout. The state directory can stay; it is what the official
plugin uses too.
