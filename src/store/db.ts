/**
 * Durable state for the daemon.
 *
 * This file is the reason delivery is a guarantee rather than a hope. Every
 * inbound Discord message becomes a `turns` row *before* any model runs, and
 * only reaches a terminal state once Discord has confirmed a message id. A
 * daemon that dies mid-turn can therefore work out, on restart, exactly what
 * it still owes — see `openTurns()` and `reconcile` in engine/delivery.ts.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { DB_FILE } from '../config'

/**
 * Turn lifecycle. `delivering` is the crash-critical one: it means the model
 * finished and we were mid-send, so recovery must check `reply_message_ids`
 * before deciding whether to re-send.
 */
export type TurnState =
  | 'queued'
  | 'seen'
  | 'running'
  | 'delivering'
  | 'done'
  | 'failed'

export const TERMINAL_STATES: TurnState[] = ['done', 'failed']

export type ThreadRow = {
  thread_id: string
  channel_id: string
  root_message_id: string | null
  guild_id: string | null
  /** Null until the first turn completes and the SDK hands back a session id. */
  cc_session_id: string | null
  cwd: string
  title: string | null
  state: 'open' | 'archived'
  /** Per-thread model override; null means the account default. */
  model: string | null
  /** Per-thread permission mode override; null means the daemon default. */
  permission_mode: string | null
  created_at: number
  last_active_at: number
}

export type TurnRow = {
  id: number
  thread_id: string
  inbound_message_id: string
  author_id: string
  content: string
  state: TurnState
  status_message_id: string | null
  /** JSON array of Discord message ids, set once the reply is confirmed. */
  reply_message_ids: string | null
  error: string | null
  attempts: number
  /** Usage recorded off the SDK result, so /cost needs no model call. */
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  created_at: number
  updated_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id       TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  root_message_id TEXT,
  guild_id        TEXT,
  cc_session_id   TEXT,
  cwd             TEXT NOT NULL,
  title           TEXT,
  state           TEXT NOT NULL DEFAULT 'open',
  model           TEXT,
  permission_mode TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id          TEXT NOT NULL,
  -- The idempotency key. Backlog replay and crash recovery both re-offer
  -- messages we may already hold; this constraint makes that a no-op.
  inbound_message_id TEXT NOT NULL UNIQUE,
  author_id          TEXT NOT NULL,
  content            TEXT NOT NULL,
  state              TEXT NOT NULL,
  status_message_id  TEXT,
  reply_message_ids  TEXT,
  error              TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  duration_ms        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS turns_open
  ON turns (state) WHERE state NOT IN ('done', 'failed');
CREATE INDEX IF NOT EXISTS turns_by_thread ON turns (thread_id, id);

-- Last message id seen per channel. On boot the daemon fetches everything
-- after this, so downtime does not silently swallow messages.
CREATE TABLE IF NOT EXISTS watermarks (
  channel_id           TEXT PRIMARY KEY,
  last_seen_message_id TEXT NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  request_id  TEXT PRIMARY KEY,
  turn_id     INTEGER,
  tool_name   TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  decision    TEXT,
  created_at  INTEGER NOT NULL
);
`

/**
 * Add columns introduced after a database was first created.
 *
 * The daemon is long-lived and upgraded in place, so an existing threads.db
 * predates these columns. SQLite has no ADD COLUMN IF NOT EXISTS, so compare
 * against the live schema rather than catching errors, which would also
 * swallow genuine failures.
 */
function migrate(db: Database): void {
  const columns = (table: string): Set<string> =>
    new Set(
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map(r => r.name),
    )

  const additions: Array<[string, string, string]> = [
    ['threads', 'model', 'TEXT'],
    ['threads', 'permission_mode', 'TEXT'],
    ['turns', 'cost_usd', 'REAL'],
    ['turns', 'input_tokens', 'INTEGER'],
    ['turns', 'output_tokens', 'INTEGER'],
    ['turns', 'duration_ms', 'INTEGER'],
  ]
  for (const [table, column, type] of additions) {
    if (!columns(table).has(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export function openDb(path = DB_FILE): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { create: true })
  // WAL keeps the signal/reaction writer from blocking the worker pool.
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  // Durability matters more than throughput here: a lost turn row is a
  // silently unanswered message, which is the exact bug this replaces.
  db.run('PRAGMA synchronous = FULL')
  db.run(SCHEMA)
  migrate(db)
  return db
}
