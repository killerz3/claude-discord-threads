/**
 * Read/working/answered signals on the user's own message.
 *
 * Discord rate-limits reactions per channel, and a turn can emit several
 * signals in quick succession, so every mutation goes through one serial
 * queue. Failures here are cosmetic and must never fail a turn — the queue
 * swallows errors deliberately.
 */

import type { Client, Message } from 'discord.js'
import { TYPING_REFRESH_MS } from '../config'

export const SEEN = '👀'
export const WORKING = '⏳'
export const DONE = '✅'
export const FAILED = '❌'
export const GATED = '🔐'

export class Signals {
  private queue: Promise<unknown> = Promise.resolve()
  private typing = new Map<string, { count: number; timer: Timer }>()

  constructor(private client: Client) {}

  /** Serialise a Discord side effect. Errors are logged, never thrown. */
  private enqueue(label: string, fn: () => Promise<unknown>): Promise<void> {
    this.queue = this.queue
      .then(fn)
      .catch(err => process.stderr.write(`discord-threads: signal ${label} failed: ${err}\n`))
    return this.queue as Promise<void>
  }

  react(msg: Message, emoji: string): Promise<void> {
    return this.enqueue(`react ${emoji}`, () => msg.react(emoji))
  }

  /** Remove only *our* reaction, leaving any the user added. */
  unreact(msg: Message, emoji: string): Promise<void> {
    return this.enqueue(`unreact ${emoji}`, async () => {
      const me = this.client.user?.id
      if (!me) return
      const reaction = msg.reactions.cache.get(emoji)
      if (reaction) await reaction.users.remove(me)
    })
  }

  seen(msg: Message): Promise<void> {
    return this.react(msg, SEEN)
  }

  working(msg: Message): Promise<void> {
    return this.react(msg, WORKING)
  }

  /**
   * Terminal signal. Clears the working marker first so a finished turn never
   * shows both an hourglass and a result.
   */
  async settled(msg: Message, ok: boolean): Promise<void> {
    await this.unreact(msg, WORKING)
    await this.react(msg, ok ? DONE : FAILED)
  }

  /**
   * Discord's typing indicator lapses after about ten seconds, so it has to be
   * refreshed. Reference-counted because several turns can share a channel.
   */
  startTyping(channelId: string, send: () => Promise<unknown>): void {
    const existing = this.typing.get(channelId)
    if (existing) {
      existing.count++
      return
    }
    const tick = () => void send().catch(() => {})
    tick()
    const timer = setInterval(tick, TYPING_REFRESH_MS)
    // Never let the typing indicator hold the process open at shutdown.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.typing.set(channelId, { count: 1, timer })
  }

  stopTyping(channelId: string): void {
    const entry = this.typing.get(channelId)
    if (!entry) return
    if (--entry.count > 0) return
    clearInterval(entry.timer)
    this.typing.delete(channelId)
  }

  /** Wait for every queued side effect to land. Used by tests and shutdown. */
  drain(): Promise<unknown> {
    return this.queue
  }
}
