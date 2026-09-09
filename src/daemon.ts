#!/usr/bin/env bun
/**
 * discord-threads daemon.
 *
 * Owns the single Discord gateway login, maps each conversation to a thread,
 * and guarantees that every accepted message gets an answer. The model is a
 * worker behind `Responder`; it is never responsible for delivery.
 */

import { Client, GatewayIntentBits, Partials, ChannelType, type Message } from 'discord.js'
import { loadEnvFile, MAX_LIVE_WORKERS } from './config'
import { openDb, type TurnRow } from './store/db'
import { Repo } from './store/repo'
import { gate, loadAccess, noteSent, watchApprovals } from './discord/access'
import { Signals } from './discord/signals'
import { fetchSendable, resolveConversation, renameThread } from './discord/threads'
import { Delivery, type Responder, type TurnContext } from './engine/delivery'
import { acquireSingleInstanceLock } from './lock'
import { echoResponder } from './engine/echo'

loadEnvFile()

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    'discord-threads: DISCORD_BOT_TOKEN required\n' +
      '  set it in ~/.claude/channels/discord/.env as DISCORD_BOT_TOKEN=MTIz...\n',
  )
  process.exit(1)
}

// Exactly one gateway login on this token. The bug this whole project exists
// to fix was N logins from N Claude Code sessions; refusing to start twice is
// how we keep that from coming back.
const lock = acquireSingleInstanceLock()
if (!lock.acquired) {
  process.stderr.write(`discord-threads: already running as pid ${lock.heldBy}. Refusing to start.\n`)
  process.exit(1)
}

const DEFAULT_CWD = process.env.DISCORD_WORKER_CWD ?? process.env.HOME ?? process.cwd()

const db = openDb()
const repo = new Repo(db)

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // DMs arrive as partial channels; messageCreate never fires without this.
  partials: [Partials.Channel],
})

const signals = new Signals(client)

/**
 * Swappable so Phase 1 can run the whole pipeline — gate, threads, signals,
 * ledger, recovery — without spending model tokens.
 */
async function buildResponder(): Promise<Responder> {
  if (process.env.DISCORD_RESPONDER === 'echo') return echoResponder
  const { claudeResponder } = await import('./engine/worker')
  return claudeResponder
}

const delivery = new Delivery({
  repo,
  signals,
  responder: await buildResponder(),
  resolveTarget: id => fetchSendable(client, id),
  chunkMode: 'newline',
})

/** DM channel id → user id, for the outbound allowlist check on DMs. */
const dmChannelUsers = new Map<string, string>()

async function handleInbound(msg: Message): Promise<void> {
  const result = await gate(client, msg)
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      const sent = await msg.reply(
        `${lead} — run in Claude Code:\n\n/discord-threads:access pair ${result.code}`,
      )
      noteSent(sent.id)
    } catch (err) {
      process.stderr.write(`discord-threads: failed to send pairing code: ${err}\n`)
    }
    return
  }

  if (msg.channel.type === ChannelType.DM) dmChannelUsers.set(msg.channelId, msg.author.id)

  // Acknowledge receipt before doing anything slow. If the process dies after
  // this point the watermark and ledger still cover the message.
  await signals.seen(msg)

  const convo = await resolveConversation(msg, repo)
  const thread =
    repo.getThread(convo.id) ??
    repo.createThread({
      thread_id: convo.id,
      channel_id: convo.channelId,
      root_message_id: convo.created ? msg.id : null,
      guild_id: convo.guildId,
      cc_session_id: null,
      cwd: DEFAULT_CWD,
      title: null,
      state: 'open',
    })

  const turn = repo.enqueueTurn({
    threadId: convo.id,
    inboundMessageId: msg.id,
    authorId: msg.author.id,
    content: msg.content,
  })
  repo.setWatermark(convo.channelId, msg.id)
  // Already held: a gateway redelivery or a backlog replay raced us.
  if (!turn) return

  signals.startTyping(convo.id, () => sendTyping(convo.id))
  void delivery
    .submit({
      turn,
      conversationId: convo.id,
      message: msg,
      sessionId: thread.cc_session_id,
      cwd: thread.cwd,
    })
    .finally(() => signals.stopTyping(convo.id))
}

async function sendTyping(channelId: string): Promise<void> {
  const ch = await client.channels.fetch(channelId)
  if (ch && 'sendTyping' in ch) await ch.sendTyping()
}

/**
 * Rebuild a turn context for a row loaded from disk. The originating Message
 * is refetched when possible so signals still land on it; a turn whose thread
 * is gone is unrecoverable and gets failed rather than silently dropped.
 */
async function hydrate(turn: TurnRow): Promise<TurnContext | null> {
  const thread = repo.getThread(turn.thread_id)
  if (!thread) return null
  let message: Message | null = null
  try {
    const ch = await client.channels.fetch(turn.thread_id)
    if (ch?.isTextBased()) message = await ch.messages.fetch(turn.inbound_message_id)
  } catch {
    // The message may live in the parent channel (it is the thread root), or
    // have been deleted. Neither is fatal — we can still answer in the thread.
  }
  return {
    turn,
    conversationId: thread.thread_id,
    message,
    sessionId: thread.cc_session_id,
    cwd: thread.cwd,
  }
}

/**
 * Answer anything that arrived while we were down.
 *
 * This is the half of durability the official plugin has no answer for: with
 * no daemon running, an inbound message simply vanishes.
 */
async function replayBacklog(): Promise<number> {
  const access = loadAccess()
  let queued = 0

  for (const channelId of Object.keys(access.groups)) {
    const after = repo.getWatermark(channelId)
    if (!after) continue
    try {
      const ch = await client.channels.fetch(channelId)
      if (!ch?.isTextBased()) continue
      const missed = await ch.messages.fetch({ after, limit: 50 })
      // fetch() returns newest-first; process oldest-first so threads read right.
      for (const msg of [...missed.values()].reverse()) {
        if (msg.author.bot) continue
        await handleInbound(msg)
        queued++
      }
    } catch (err) {
      process.stderr.write(`discord-threads: backlog replay failed for ${channelId}: ${err}\n`)
    }
  }
  return queued
}

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(err =>
    process.stderr.write(`discord-threads: handleInbound failed: ${err}\n`),
  )
})

client.on('error', err => process.stderr.write(`discord-threads: client error: ${err}\n`))

// 'clientReady' rather than 'ready': the latter is deprecated in discord.js 14
// and is removed in v15, where it means the raw gateway READY instead.
client.once('clientReady', async c => {
  process.stderr.write(
    `discord-threads: gateway connected as ${c.user.tag} ` +
      `(max ${MAX_LIVE_WORKERS} concurrent turns)\n`,
  )
  // The access skill signals approvals by dropping files; pick them up.
  watchApprovals(client)
  const recovered = await delivery.recover(hydrate)
  const replayed = await replayBacklog()
  process.stderr.write(
    `discord-threads: recovery — ${recovered.replayed} in-flight replayed, ` +
      `${recovered.reconciled} already delivered, ${recovered.dropped} unrecoverable, ` +
      `${replayed} from backlog\n`,
  )
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord-threads: shutting down\n')
  // Give in-flight turns a chance to land before dropping the connection;
  // anything unfinished is still on the ledger and replays next boot.
  const forced = setTimeout(() => process.exit(0), 10_000)
  if (typeof forced === 'object' && 'unref' in forced) forced.unref()
  await delivery.drain().catch(() => {})
  await signals.drain().catch(() => {})
  await Promise.resolve(client.destroy()).catch(() => {})
  lock.release()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('unhandledRejection', err =>
  process.stderr.write(`discord-threads: unhandled rejection: ${err}\n`),
)
process.on('uncaughtException', err =>
  process.stderr.write(`discord-threads: uncaught exception: ${err}\n`),
)

export { renameThread }

await client.login(TOKEN)
