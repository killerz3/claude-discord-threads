/**
 * Access control: who may reach this bot, and on which channels.
 *
 * Ported from the official discord plugin's server.ts with its semantics
 * intact — the file format, the pairing flow and the `/…:access` skill that
 * edits it are all unchanged, so an existing install keeps working. The only
 * structural change is that the client is passed in rather than closed over,
 * because the daemon owns exactly one client and tests need to fake it.
 *
 * Access decisions are re-read from disk on every message, so the skill's
 * edits take effect without a restart.
 */

import { ChannelType, type Client, type Message } from 'discord.js'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { ACCESS_FILE, APPROVED_DIR, STATE_DIR } from '../config'

export type PendingEntry = {
  senderId: string
  /** DM channel ID — where the approval confirmation gets sent. */
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID: one entry per channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

export function loadAccess(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    // Corrupt file: move aside rather than silently reverting to defaults,
    // which would drop the allowlist and re-open pairing.
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write('discord-threads: access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccess()
  }
}

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

/**
 * Message ids we recently sent, so that a reply to one of our messages counts
 * as a mention without paying for a fetchReference() round trip.
 */
const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

export function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    // Sets iterate in insertion order, so this drops the oldest.
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

/**
 * The channel key a message is gated on. Threads inherit their parent
 * channel's opt-in, so a thread the daemon opens does not need its own entry.
 */
export function gateChannelKey(msg: Message): string {
  return msg.channel.isThread() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId
}

export async function gate(client: Client, msg: Message): Promise<GateResult> {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id

  if (msg.channel.type === ChannelType.DM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // Pairing mode: reuse an outstanding code for this sender if there is one.
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Answer twice at most (initial + one reminder), then go quiet, so an
        // unapproved sender cannot use us as an echo service.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const now = Date.now()
    const code = randomBytes(3).toString('hex')
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  const policy = access.groups[gateChannelKey(msg)]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if ((policy.requireMention ?? true) && !(await isMentioned(client, msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

/**
 * Deliver pairing confirmations.
 *
 * The access skill approves a sender by dropping `approved/<senderId>` whose
 * contents are the DM channel id. It has to carry the channel id because a
 * Discord DM channel is not the user id, and by the time we see the marker the
 * pending entry that held it is already gone.
 */
export function watchApprovals(client: Client, intervalMs = 5000): Timer {
  const tick = () => {
    let files: string[]
    try {
      files = readdirSync(APPROVED_DIR)
    } catch {
      return
    }
    for (const senderId of files) {
      const file = join(APPROVED_DIR, senderId)
      let dmChannelId = ''
      try {
        dmChannelId = readFileSync(file, 'utf8').trim()
      } catch {}
      if (!dmChannelId) {
        rmSync(file, { force: true })
        continue
      }
      void (async () => {
        try {
          const ch = await client.channels.fetch(dmChannelId)
          if (ch?.isTextBased() && ch.isSendable()) {
            const sent = await ch.send('Paired! Say hi to Claude.')
            noteSent(sent.id)
          }
        } catch (err) {
          process.stderr.write(`discord-threads: approval confirm failed: ${err}\n`)
        } finally {
          // Remove either way — never loop on a send that cannot succeed.
          rmSync(file, { force: true })
        }
      })()
    }
  }
  const timer = setInterval(tick, intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return timer
}

export async function isMentioned(
  client: Client,
  msg: Message,
  extraPatterns?: string[],
): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  // Replying to one of our messages is an implicit mention.
  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    // The message may be older than our cache, deleted, or unreadable.
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }

  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(msg.content)) return true
    } catch {}
  }
  return false
}
