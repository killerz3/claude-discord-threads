/**
 * The turn state machine — the reason a reply cannot be forgotten.
 *
 * The model never decides whether to answer. It produces text; this file is
 * what puts that text on Discord, and what remembers the obligation across a
 * crash. The contract:
 *
 *   1. a `turns` row exists before any model work starts
 *   2. `done` is set only after Discord confirms message ids
 *   3. on boot every non-terminal row is replayed, and a row that already has
 *      reply ids reconciles to `done` rather than re-sending
 *
 * Together those give exactly-once delivery across kill -9.
 */

import type { Message, SendableChannels } from 'discord.js'
import type { Repo } from '../store/repo'
import type { TurnRow } from '../store/db'
import type { Signals } from '../discord/signals'
import { sendReply } from '../discord/threads'
import { MAX_LIVE_WORKERS } from '../config'

/** How many restarts a single turn may be replayed across before it is dropped. */
const MAX_REPLAY_ATTEMPTS = 3

export type TurnContext = {
  turn: TurnRow
  conversationId: string
  /** Null when replaying from history, where the live Message is gone. */
  message: Message | null
  /** Resumes the thread's existing Claude Code session when set. */
  sessionId: string | null
  cwd: string
  /** Per-thread overrides; null means fall back to the daemon default. */
  model?: string | null
  permissionMode?: string | null
  /** Aborted by `/stop`. The worker passes it to the SDK. */
  abort?: AbortController
  onToolUse?: (label: string) => void
  /** Posts an answer the model gives after its turn, when background work finishes. */
  onLateReply?: (text: string) => Promise<void>
}

export type ResponderResult =
  | {
      kind: 'reply'
      text: string
      sessionId?: string
      files?: string[]
      title?: string
      usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number }
    }
  /** Transient — the turn goes back on the queue rather than failing. */
  | { kind: 'retry'; afterMs: number; reason: string }
  | { kind: 'error'; message: string }

export type Responder = (ctx: TurnContext) => Promise<ResponderResult>

export type DeliveryDeps = {
  repo: Repo
  signals: Signals
  responder: Responder
  /** Resolve where to post, and how the conversation is configured. */
  resolveTarget: (conversationId: string) => Promise<SendableChannels>
  chunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export class Delivery {
  /** Serial chain per conversation: turns in one thread stay ordered. */
  private chains = new Map<string, Promise<void>>()
  /** In-flight turns, so `/stop` can reach the right one. */
  private running = new Map<string, AbortController>()
  private live = 0
  private waiters: Array<() => void> = []
  private stopped = false
  private shuttingDown = false

  constructor(private deps: DeliveryDeps) {}

  /**
   * Queue a turn. Ordering is per-conversation; concurrency is global.
   * Returns a promise that settles when this turn reaches a terminal state,
   * which is what the tests await.
   */
  submit(ctx: TurnContext): Promise<void> {
    const prev = this.chains.get(ctx.conversationId) ?? Promise.resolve()
    const next = prev.then(() => this.run(ctx)).catch(err => {
      process.stderr.write(`discord-threads: turn ${ctx.turn.id} crashed: ${err}\n`)
    })
    this.chains.set(ctx.conversationId, next)
    void next.then(() => {
      // Drop the chain once it is idle so the map does not grow without bound.
      if (this.chains.get(ctx.conversationId) === next) this.chains.delete(ctx.conversationId)
    })
    return next
  }

  private async acquire(): Promise<void> {
    if (this.live < MAX_LIVE_WORKERS) {
      this.live++
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.live++
  }

  private release(): void {
    this.live--
    const next = this.waiters.shift()
    if (next) next()
  }

  private async run(ctx: TurnContext): Promise<void> {
    if (this.stopped) return

    // Re-read: a concurrent recovery pass may already have settled this turn.
    const fresh = this.deps.repo.getTurn(ctx.turn.id)
    if (!fresh || fresh.state === 'done' || fresh.state === 'failed') return

    const { repo, signals } = this.deps
    const msg = ctx.message

    await this.acquire()
    const abort = ctx.abort ?? new AbortController()
    this.running.set(ctx.conversationId, abort)
    try {
      repo.setTurnState(ctx.turn.id, 'running')
      if (msg) void signals.working(msg)

      const onLateReply = (text: string) =>
        this.post(ctx, text).then(
          () => {},
          err => void process.stderr.write(`discord-threads: late reply for turn ${ctx.turn.id} failed: ${err}\n`),
        )
      const result = await this.deps.responder({ ...ctx, turn: fresh, abort, onLateReply })

      if (result.kind === 'retry') {
        // Not a failure: the obligation stands, so put it back on the queue.
        repo.requeueTurn(ctx.turn.id, result.reason)
        await this.post(ctx, `⏱️ Rate limited — retrying in ${Math.ceil(result.afterMs / 1000)}s.`)
        setTimeout(() => void this.submit({ ...ctx, turn: repo.getTurn(ctx.turn.id)! }), result.afterMs)
        return
      }

      if (result.kind === 'error') {
        if (this.shuttingDown) return this.deferForRestart(ctx, result.message)
        repo.failTurn(ctx.turn.id, result.message)
        await this.post(ctx, `❌ ${result.message}`)
        if (msg) await signals.settled(msg, false)
        return
      }

      if (result.sessionId) repo.setThreadSession(ctx.conversationId, result.sessionId)
      if (result.usage) repo.recordTurnUsage(ctx.turn.id, result.usage)

      // Mark the intent to send *before* sending. A crash between here and
      // finishTurn leaves the row in `delivering`, which recovery treats as
      // "check whether it actually went out".
      repo.setTurnState(ctx.turn.id, 'delivering')

      const ids = await this.post(ctx, result.text, result.files)
      if (ids.length === 0) {
        repo.failTurn(ctx.turn.id, 'reply produced no Discord message')
        if (msg) await signals.settled(msg, false)
        return
      }

      repo.finishTurn(ctx.turn.id, ids)
      repo.touchThread(ctx.conversationId)
      if (msg) await signals.settled(msg, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.shuttingDown) {
        this.deferForRestart(ctx, message)
      } else {
        repo.failTurn(ctx.turn.id, message)
        await this.post(ctx, `❌ ${message}`).catch(() => {})
        if (msg) await signals.settled(msg, false).catch(() => {})
      }
    } finally {
      if (this.running.get(ctx.conversationId) === abort) this.running.delete(ctx.conversationId)
      this.release()
    }
  }

  /**
   * Hand an interrupted turn back to the ledger instead of failing it.
   *
   * `queued` is non-terminal, so `recover()` picks it up on the next boot and
   * the user gets their answer a few seconds late rather than never. Nothing is
   * posted: an error the operator caused by restarting is noise, and the reply
   * is still coming.
   */
  private deferForRestart(ctx: TurnContext, reason: string): void {
    // A turn the user cancelled with `/stop` is not owed an answer; replaying
    // it would resurrect work they explicitly killed.
    if (ctx.abort?.signal.aborted) {
      this.deps.repo.failTurn(ctx.turn.id, reason)
      return
    }
    this.deps.repo.requeueTurn(ctx.turn.id, `interrupted by restart: ${reason}`)
  }

  /**
   * Announce that the process is going away.
   *
   * Distinguishes "the turn failed" from "we killed the turn". Under systemd
   * the SIGTERM goes to the whole cgroup, so the worker's Claude Code child
   * dies too and the SDK throws — which is indistinguishable, at the catch
   * site, from a genuine crash. Without this flag that exception marks the
   * turn `failed`, a terminal state, and the reply the user was waiting for is
   * lost across a restart the operator asked for on purpose.
   */
  beginShutdown(): void {
    this.shuttingDown = true
  }

  /** Cancel the turn running in a conversation. Returns false if none is. */
  interrupt(conversationId: string): boolean {
    const abort = this.running.get(conversationId)
    if (!abort) return false
    abort.abort()
    return true
  }

  private async post(ctx: TurnContext, text: string, files?: string[]): Promise<string[]> {
    const ch = await this.deps.resolveTarget(ctx.conversationId)
    const { ids, error } = await sendReply(ch, text, {
      files,
      chunkLimit: this.deps.chunkLimit,
      chunkMode: this.deps.chunkMode,
    })
    if (error && ids.length === 0) throw error
    if (error) {
      process.stderr.write(
        `discord-threads: turn ${ctx.turn.id} sent ${ids.length} chunk(s) then failed: ${error}\n`,
      )
    }
    return ids
  }

  /**
   * Rebuild the work queue after a restart.
   *
   * A row in `delivering` is the dangerous case: the model had finished and we
   * were mid-send. If reply ids were recorded the answer is already on Discord
   * and re-running would double-post, so it is reconciled to `done` instead.
   *
   * Rows requeued by `beginShutdown` land here too: an operator restart is just
   * a crash the process saw coming.
   */
  async recover(
    hydrate: (turn: TurnRow) => Promise<TurnContext | null>,
  ): Promise<{ replayed: number; reconciled: number; dropped: number }> {
    const { repo } = this.deps
    let replayed = 0
    let reconciled = 0
    let dropped = 0

    for (const turn of repo.openTurns()) {
      if (repo.replyIdsOf(turn).length > 0) {
        repo.finishTurn(turn.id, repo.replyIdsOf(turn))
        reconciled++
        continue
      }
      // A turn that has already survived several restarts is more likely to be
      // the thing killing the process than a victim of it, so stop replaying.
      if (turn.attempts >= MAX_REPLAY_ATTEMPTS) {
        repo.failTurn(turn.id, `gave up after ${turn.attempts} restarts`)
        dropped++
        continue
      }
      const ctx = await hydrate(turn)
      if (!ctx) {
        repo.failTurn(turn.id, 'conversation no longer reachable on restart')
        dropped++
        continue
      }
      void this.submit(ctx)
      replayed++
    }
    return { replayed, reconciled, dropped }
  }

  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.chains.values()])
  }
}
