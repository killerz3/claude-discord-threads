/**
 * Logging.
 *
 * The daemon runs under systemd, so stderr is the journal. Plain lines are
 * readable with `journalctl -f`; set DISCORD_LOG_JSON=1 to emit one JSON object
 * per line instead, for anything that wants to parse them.
 */

const JSON_MODE = process.env.DISCORD_LOG_JSON === '1'
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof LEVELS
const MIN = LEVELS[(process.env.DISCORD_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < MIN) return
  if (JSON_MODE) {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }) + '\n',
    )
    return
  }
  const extra = fields
    ? ' ' +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : ''
  process.stderr.write(`discord-threads: ${message}${extra}\n`)
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
}

/** Errors reach the log as messages, not `[object Object]`. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
