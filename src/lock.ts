/**
 * Single-instance guard.
 *
 * Two daemons on one bot token would both receive every message and both
 * answer it. That is the multi-login failure the official plugin has by
 * construction, so it is worth refusing to start rather than detecting later.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { STATE_DIR } from './config'

const LOCK_FILE = process.env.DISCORD_LOCK_FILE ?? join(STATE_DIR, 'daemon.lock')

export type LockHandle =
  | { acquired: true; release: () => void }
  | { acquired: false; heldBy: number; release: () => void }

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireSingleInstanceLock(file = LOCK_FILE): LockHandle {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists — the atomic part.
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      const release = () => {
        try {
          // Only remove a lock we still own, so we cannot delete a successor's.
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file)
        } catch {}
      }
      process.once('exit', release)
      return { acquired: true, release }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      let heldBy = 0
      try {
        heldBy = Number(readFileSync(file, 'utf8').trim())
      } catch {}

      if (heldBy && isAlive(heldBy)) {
        return { acquired: false, heldBy, release: () => {} }
      }
      // Stale lock from a crashed daemon: clear it and retry once.
      try { unlinkSync(file) } catch {}
    }
  }
  return { acquired: false, heldBy: 0, release: () => {} }
}
