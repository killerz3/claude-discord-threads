/**
 * The live "what is it doing" line.
 *
 * One message per turn, edited in place as tools run, then deleted when the
 * real answer arrives. Edits deliberately do not trigger push notifications,
 * which is exactly what you want for progress — the answer itself is a fresh
 * message, so the phone still buzzes once, at the end.
 */

import type { Client, Message } from 'discord.js'
import { fetchSendable } from './threads'
import { noteSent } from './access'

/** Discord rate-limits edits; anything faster than this is wasted. */
const EDIT_INTERVAL_MS = 2500

export class StatusLine {
  private message: Message | null = null
  private tools: string[] = []
  private lastEdit = 0
  private pending: Timer | null = null
  private closed = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private client: Client,
    private conversationId: string,
  ) {}

  /** Record a tool call and schedule a refresh. */
  note(tool: string): void {
    if (this.closed) return
    // Collapse consecutive repeats: "Bash ×3" reads better than three lines.
    const last = this.tools[this.tools.length - 1]
    if (last === tool) return
    this.tools.push(tool)
    this.schedule()
  }

  private schedule(): void {
    if (this.closed || this.pending) return
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEdit))
    const timer = setTimeout(() => {
      this.pending = null
      this.lastEdit = Date.now()
      this.chain = this.chain.then(() => this.flush()).catch(() => {})
    }, wait)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.pending = timer
  }

  private async flush(): Promise<void> {
    if (this.closed) return
    const body = this.render()
    if (this.message) {
      await this.message.edit(body).catch(() => {})
      return
    }
    const ch = await fetchSendable(this.client, this.conversationId)
    const sent = await ch.send(body)
    noteSent(sent.id)
    this.message = sent
  }

  private render(): string {
    const recent = this.tools.slice(-6)
    const elided = this.tools.length > recent.length ? '… ' : ''
    return `⏳ ${elided}${recent.join(' → ')}`
  }

  /**
   * Remove the status line. Called once the answer is posted, so a finished
   * thread reads as question → answer with no scaffolding left behind.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.pending) clearTimeout(this.pending)
    await this.chain.catch(() => {})
    if (this.message) {
      await this.message.delete().catch(() => {})
      this.message = null
    }
  }
}
