/**
 * Paths and tunables.
 *
 * State deliberately lives in the same directory the official discord plugin
 * uses, so an existing install keeps its token, allowlist and pairings with no
 * migration step.
 */

import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR =
  process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')

export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const ENV_FILE = join(STATE_DIR, '.env')
export const DB_FILE = process.env.DISCORD_DB_FILE ?? join(STATE_DIR, 'threads.db')

/**
 * Load STATE_DIR/.env into process.env. Real env wins.
 *
 * Carried over from the official plugin: the token lives on disk because a
 * plugin-spawned server gets no env block. The daemon reads the same file so
 * that a token already configured for the official plugin keeps working.
 */
export function loadEnvFile(): void {
  try {
    // Token is a credential — lock to owner. No-op on Windows (needs ACLs).
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (!m) continue
      const [, key, value] = m
      if (key && process.env[key] === undefined) process.env[key] = value ?? ''
    }
  } catch {}
}

/** Discord's hard cap on message length. Sends above this are rejected. */
export const MAX_CHUNK_LIMIT = 2000

/** Discord's per-attachment size cap on a non-boosted guild. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * Live worker cap. Each Claude Code process measures ~400MB resident, and
 * workers share the account's rate-limit budget with the operator's own
 * interactive sessions — so this is deliberately small. Turns beyond the cap
 * queue rather than failing.
 */
export const MAX_LIVE_WORKERS = Number(process.env.DISCORD_MAX_WORKERS ?? 3)

/** Idle worker processes are reaped after this long; the session id is kept
 *  so the next message resumes the same conversation. */
export const WORKER_IDLE_MS = 20 * 60 * 1000

/** How long a permission request waits on Discord buttons before denying. */
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

/** Discord's typing indicator lapses after ~10s; refresh inside that. */
export const TYPING_REFRESH_MS = 8000
