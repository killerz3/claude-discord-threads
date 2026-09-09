/**
 * Mapping Discord surfaces onto conversations.
 *
 * A conversation is identified by the channel we talk in:
 *   - guild channel, top-level message → open a thread on that message, and
 *     the thread is the conversation
 *   - message already inside one of our threads → that thread
 *   - DM → the DM channel itself, because Discord has no DM threads
 *
 * Because a thread opened on a message takes that message's id, `thread_id`
 * doubles as `root_message_id` in the guild case.
 */

import {
  ChannelType,
  type Client,
  type Message,
  type SendableChannels,
  type TextChannel,
} from 'discord.js'
import type { Repo } from '../store/repo'
import { noteSent } from './access'
import { chunk, clampChunkLimit, threadName } from './util'

export type Conversation = {
  /** Conversation key: a thread id in guilds, the DM channel id otherwise. */
  id: string
  /** Where the gate opt-in lives — the parent channel for threads. */
  channelId: string
  guildId: string | null
  isDM: boolean
  /** Set when this call created the thread, so the caller can seed a title. */
  created: boolean
}

/**
 * Resolve (or open) the conversation a message belongs to.
 *
 * Thread creation can fail on a guild that has not granted
 * CREATE_PUBLIC_THREADS. That is a configuration problem, not a reason to drop
 * the message, so we fall back to answering in the channel and say so once.
 */
export async function resolveConversation(msg: Message, repo: Repo): Promise<Conversation> {
  if (msg.channel.type === ChannelType.DM) {
    return {
      id: msg.channelId,
      channelId: msg.channelId,
      guildId: null,
      isDM: true,
      created: false,
    }
  }

  if (msg.channel.isThread()) {
    return {
      id: msg.channelId,
      channelId: msg.channel.parentId ?? msg.channelId,
      guildId: msg.guildId,
      isDM: false,
      created: false,
    }
  }

  try {
    const thread = await msg.startThread({
      name: threadName(msg.content),
      autoArchiveDuration: 1440,
    })
    noteSent(thread.id)
    return {
      id: thread.id,
      channelId: msg.channelId,
      guildId: msg.guildId,
      isDM: false,
      created: true,
    }
  } catch (err) {
    process.stderr.write(
      `discord-threads: could not open a thread on ${msg.id} (${err}); ` +
        `answering in-channel. Grant the bot CREATE_PUBLIC_THREADS to enable threading.\n`,
    )
    return {
      id: msg.channelId,
      channelId: msg.channelId,
      guildId: msg.guildId,
      isDM: false,
      created: false,
    }
  }
}

export async function fetchSendable(client: Client, id: string): Promise<SendableChannels> {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased() || !ch.isSendable()) {
    throw new Error(`channel ${id} not found or not sendable`)
  }
  return ch
}

/**
 * Outbound gate: the daemon may only send where the inbound gate would have
 * accepted a message from. Mirrors the thread → parent lookup so a thread we
 * opened inherits its parent's opt-in.
 */
export async function assertAllowedTarget(
  client: Client,
  id: string,
  isAllowed: (key: string, isDM: boolean, recipientId: string | null) => boolean,
): Promise<SendableChannels> {
  const ch = await fetchSendable(client, id)
  if (ch.type === ChannelType.DM) {
    const recipientId = 'recipientId' in ch ? (ch.recipientId ?? null) : null
    if (isAllowed(id, true, recipientId)) return ch
  } else {
    const key = ch.isThread() ? (ch.parentId ?? ch.id) : ch.id
    if (isAllowed(key, false, null)) return ch
  }
  throw new Error(`channel ${id} is not allowlisted`)
}

export type SendOptions = {
  replyTo?: string
  files?: string[]
  chunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

/**
 * Send a reply, splitting it to fit Discord's 2000-character cap.
 *
 * Returns every message id created. A partial failure still reports what did
 * land, because the caller records those ids to avoid re-sending them after a
 * crash.
 */
export async function sendReply(
  ch: SendableChannels,
  text: string,
  opts: SendOptions = {},
): Promise<{ ids: string[]; error?: Error }> {
  const limit = clampChunkLimit(opts.chunkLimit)
  const chunks = chunk(text, limit, opts.chunkMode ?? 'newline')
  const files = opts.files ?? []
  const ids: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    try {
      const sent = await ch.send({
        content: chunks[i]!,
        ...(i === 0 && files.length > 0 ? { files } : {}),
        // Quote-reply only the first chunk; threading every part is noise.
        ...(i === 0 && opts.replyTo
          ? { reply: { messageReference: opts.replyTo, failIfNotExists: false } }
          : {}),
      })
      noteSent(sent.id)
      ids.push(sent.id)
    } catch (err) {
      return { ids, error: err instanceof Error ? err : new Error(String(err)) }
    }
  }
  return { ids }
}

/** Rename a thread once the conversation has a real topic. */
export async function renameThread(client: Client, threadId: string, title: string): Promise<void> {
  const ch = await client.channels.fetch(threadId)
  if (ch?.isThread()) await ch.setName(threadName(title))
}

export function isTextChannel(ch: unknown): ch is TextChannel {
  return (
    typeof ch === 'object' &&
    ch !== null &&
    'type' in ch &&
    (ch as { type: unknown }).type === ChannelType.GuildText
  )
}
