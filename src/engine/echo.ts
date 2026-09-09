/**
 * A responder that spends no model tokens.
 *
 * Used to exercise the whole pipeline — gate, thread creation, signals, the
 * turn ledger, crash recovery, backlog replay — in isolation from Claude, and
 * as the stand-in in tests. Enable with DISCORD_RESPONDER=echo.
 */

import type { Responder } from './delivery'

export const echoResponder: Responder = async ctx => {
  ctx.onToolUse?.('echo')
  return {
    kind: 'reply',
    text:
      `echo (turn ${ctx.turn.id}, attempt ${ctx.turn.attempts + 1})\n` +
      '```\n' +
      ctx.turn.content.slice(0, 1500) +
      '\n```',
  }
}
