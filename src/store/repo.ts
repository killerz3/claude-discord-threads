/**
 * Query layer over the turn ledger.
 *
 * Every state transition goes through here so that the invariants live in one
 * place: a turn is created before any model work, and only `finishTurn` /
 * `failTurn` may move it to a terminal state.
 */

import type { Database } from 'bun:sqlite'
import type { ThreadRow, TurnRow, TurnState } from './db'

export class Repo {
  constructor(private db: Database) {}

  // ---- threads ----------------------------------------------------------

  getThread(threadId: string): ThreadRow | null {
    return this.db
      .query<ThreadRow, [string]>('SELECT * FROM threads WHERE thread_id = ?')
      .get(threadId)
  }

  createThread(row: Omit<ThreadRow, 'created_at' | 'last_active_at'>): ThreadRow {
    const now = Date.now()
    this.db.run(
      `INSERT INTO threads
         (thread_id, channel_id, root_message_id, guild_id, cc_session_id,
          cwd, title, state, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO NOTHING`,
      [
        row.thread_id,
        row.channel_id,
        row.root_message_id,
        row.guild_id,
        row.cc_session_id,
        row.cwd,
        row.title,
        row.state,
        now,
        now,
      ],
    )
    return this.getThread(row.thread_id)!
  }

  /**
   * Persisted the first time a turn completes. This is what lets a reaped or
   * crashed worker resume the same conversation instead of starting fresh.
   */
  setThreadSession(threadId: string, sessionId: string): void {
    this.db.run('UPDATE threads SET cc_session_id = ?, last_active_at = ? WHERE thread_id = ?', [
      sessionId,
      Date.now(),
      threadId,
    ])
  }

  setThreadTitle(threadId: string, title: string): void {
    this.db.run('UPDATE threads SET title = ? WHERE thread_id = ?', [title, threadId])
  }

  setThreadCwd(threadId: string, cwd: string): void {
    this.db.run('UPDATE threads SET cwd = ? WHERE thread_id = ?', [cwd, threadId])
  }

  setThreadModel(threadId: string, model: string | null): void {
    this.db.run('UPDATE threads SET model = ? WHERE thread_id = ?', [model, threadId])
  }

  setThreadPermissionMode(threadId: string, mode: string | null): void {
    this.db.run('UPDATE threads SET permission_mode = ? WHERE thread_id = ?', [mode, threadId])
  }

  /**
   * Forget the conversation but keep the thread. `/clear` uses this: the next
   * message starts a fresh Claude Code session in the same Discord thread.
   */
  clearThreadSession(threadId: string): void {
    this.db.run('UPDATE threads SET cc_session_id = NULL WHERE thread_id = ?', [threadId])
  }

  openThreads(): ThreadRow[] {
    return this.db
      .query<ThreadRow, []>(
        "SELECT * FROM threads WHERE state = 'open' ORDER BY last_active_at DESC",
      )
      .all()
  }

  archiveThread(threadId: string): void {
    this.db.run("UPDATE threads SET state = 'archived' WHERE thread_id = ?", [threadId])
  }

  touchThread(threadId: string): void {
    this.db.run('UPDATE threads SET last_active_at = ? WHERE thread_id = ?', [
      Date.now(),
      threadId,
    ])
  }

  /**
   * Open threads with no activity since `before`. Drives idle archiving, and
   * is ordered oldest-first so a sweep that hits a rate limit makes progress
   * on the stalest ones.
   */
  idleThreads(before: number): ThreadRow[] {
    return this.db
      .query<ThreadRow, [number]>(
        `SELECT * FROM threads
         WHERE state = 'open' AND last_active_at < ?
         ORDER BY last_active_at ASC`,
      )
      .all(before)
  }

  // ---- turns ------------------------------------------------------------

  turnCount(threadId: string): { done: number; failed: number; open: number } {
    const rows = this.db
      .query<{ state: string; c: number }, [string]>(
        'SELECT state, count(*) AS c FROM turns WHERE thread_id = ? GROUP BY state',
      )
      .all(threadId)
    const out = { done: 0, failed: 0, open: 0 }
    for (const r of rows) {
      if (r.state === 'done') out.done += r.c
      else if (r.state === 'failed') out.failed += r.c
      else out.open += r.c
    }
    return out
  }

  /**
   * Record an inbound message as owed work.
   *
   * Returns null when we already hold this message. Both backlog replay and
   * gateway redelivery can offer the same message twice, and the UNIQUE
   * constraint on inbound_message_id is what makes that a no-op rather than a
   * duplicate answer.
   */
  enqueueTurn(input: {
    threadId: string
    inboundMessageId: string
    authorId: string
    content: string
  }): TurnRow | null {
    const now = Date.now()
    const changed = this.db.run(
      `INSERT INTO turns
         (thread_id, inbound_message_id, author_id, content, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)
       ON CONFLICT(inbound_message_id) DO NOTHING`,
      [input.threadId, input.inboundMessageId, input.authorId, input.content, now, now],
    )
    if (changed.changes === 0) return null
    return this.getTurnByMessage(input.inboundMessageId)
  }

  getTurn(id: number): TurnRow | null {
    return this.db.query<TurnRow, [number]>('SELECT * FROM turns WHERE id = ?').get(id)
  }

  getTurnByMessage(messageId: string): TurnRow | null {
    return this.db
      .query<TurnRow, [string]>('SELECT * FROM turns WHERE inbound_message_id = ?')
      .get(messageId)
  }

  setTurnState(id: number, state: TurnState): void {
    this.db.run('UPDATE turns SET state = ?, updated_at = ? WHERE id = ?', [
      state,
      Date.now(),
      id,
    ])
  }

  /**
   * Record what a turn consumed, straight off the SDK result. Persisting it
   * means /cost is a database read rather than another model call.
   */
  recordTurnUsage(
    id: number,
    usage: { costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number },
  ): void {
    this.db.run(
      `UPDATE turns SET cost_usd = ?, input_tokens = ?, output_tokens = ?, duration_ms = ?
       WHERE id = ?`,
      [
        usage.costUsd ?? null,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.durationMs ?? null,
        id,
      ],
    )
  }

  /**
   * Totals for one thread. Cost is cumulative *per query() call* in the SDK,
   * so each turn's recorded value is that turn's own total and summing is
   * correct here — unlike summing across results inside one streaming session.
   */
  threadUsage(threadId: string): {
    costUsd: number
    inputTokens: number
    outputTokens: number
    turns: number
  } {
    const row = this.db
      .query<
        { cost: number | null; inp: number | null; out: number | null; n: number },
        [string]
      >(
        `SELECT sum(cost_usd) AS cost, sum(input_tokens) AS inp,
                sum(output_tokens) AS out, count(*) AS n
         FROM turns WHERE thread_id = ? AND state = 'done'`,
      )
      .get(threadId)
    return {
      costUsd: row?.cost ?? 0,
      inputTokens: row?.inp ?? 0,
      outputTokens: row?.out ?? 0,
      turns: row?.n ?? 0,
    }
  }

  setStatusMessage(id: number, messageId: string): void {
    this.db.run('UPDATE turns SET status_message_id = ?, updated_at = ? WHERE id = ?', [
      messageId,
      Date.now(),
      id,
    ])
  }

  /**
   * Terminal success. Recorded only once Discord has confirmed the message
   * ids, so a crash before this point is replayable and a crash after it is
   * recognisably already delivered.
   */
  finishTurn(id: number, replyMessageIds: string[]): void {
    this.db.run(
      "UPDATE turns SET state = 'done', reply_message_ids = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(replyMessageIds), Date.now(), id],
    )
  }

  failTurn(id: number, error: string): void {
    this.db.run("UPDATE turns SET state = 'failed', error = ?, updated_at = ? WHERE id = ?", [
      error.slice(0, 2000),
      Date.now(),
      id,
    ])
  }

  /** Return a turn to the queue, e.g. after a rate limit. */
  requeueTurn(id: number, error: string): void {
    this.db.run(
      `UPDATE turns
         SET state = 'queued', attempts = attempts + 1, error = ?, updated_at = ?
       WHERE id = ?`,
      [error.slice(0, 2000), Date.now(), id],
    )
  }

  /**
   * Everything the daemon still owes an answer for, oldest first. Read on
   * boot to rebuild the work queue after a crash or restart.
   */
  openTurns(): TurnRow[] {
    return this.db
      .query<TurnRow, []>(
        `SELECT * FROM turns WHERE state NOT IN ('done', 'failed') ORDER BY id ASC`,
      )
      .all()
  }

  replyIdsOf(turn: TurnRow): string[] {
    if (!turn.reply_message_ids) return []
    try {
      return JSON.parse(turn.reply_message_ids) as string[]
    } catch {
      return []
    }
  }

  // ---- watermarks -------------------------------------------------------

  getWatermark(channelId: string): string | null {
    const row = this.db
      .query<{ last_seen_message_id: string }, [string]>(
        'SELECT last_seen_message_id FROM watermarks WHERE channel_id = ?',
      )
      .get(channelId)
    return row?.last_seen_message_id ?? null
  }

  /**
   * Snowflakes are monotonic, so the lexicographically-longer-then-greater
   * comparison below is a valid ordering and saves parsing to BigInt on a hot
   * path. Never move a watermark backwards: out-of-order gateway delivery
   * would otherwise re-open messages we already handled.
   */
  setWatermark(channelId: string, messageId: string): void {
    const current = this.getWatermark(channelId)
    if (current && !isNewerSnowflake(messageId, current)) return
    this.db.run(
      `INSERT INTO watermarks (channel_id, last_seen_message_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         last_seen_message_id = excluded.last_seen_message_id,
         updated_at = excluded.updated_at`,
      [channelId, messageId, Date.now()],
    )
  }
}

export function isNewerSnowflake(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length > b.length
  return a > b
}
