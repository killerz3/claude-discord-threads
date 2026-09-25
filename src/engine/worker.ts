/**
 * The Claude Code worker.
 *
 * One `query()` per turn, resuming the thread's stored session id. That is
 * deliberately simpler than holding a live streaming session per thread: there
 * is no worker lifecycle to supervise, no idle reaping, no stale in-memory
 * state to diverge from the ledger, and a crash costs at most one turn. The
 * price is process startup per turn, which is small next to model latency.
 *
 * Note what is *absent*: there is no reply tool. The turn's final text is
 * returned to the caller, which posts it. The model cannot forget to answer
 * because answering was never its job.
 *
 * SDK signatures are pinned in docs/sdk-notes.md against the shipped .d.ts.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Responder, ResponderResult, TurnContext } from './delivery'

/** Retry ceiling when Discord gives us no better hint. */
const DEFAULT_RETRY_MS = 60_000

/**
 * Extra guidance for the worker. It is short on purpose: the delivery contract
 * is enforced in code, so it does not need to be prompted for.
 */
const SYSTEM_APPEND = [
  'You are answering over Discord. Your final message in each turn is posted to the',
  'thread verbatim, so write it as the reply itself — no preamble about what you are',
  'about to do, and no sign-off.',
  'Keep answers tight. Use fenced code blocks for code, commands and file contents.',
  'Discord splits messages over 2000 characters, so prefer brevity over exhaustiveness.',
].join(' ')

/**
 * Match the operator's interactive sessions, which run with auto mode on.
 *
 * 'auto' puts a model classifier in front of the permission system: routine
 * calls are approved without asking, and only genuinely risky ones escalate to
 * canUseTool — i.e. to a Discord button. The SDK default is 'default', which
 * prompts on every Bash call and makes the bot unusable for offloading work.
 */
const DEFAULT_PERMISSION_MODE = (process.env.DISCORD_PERMISSION_MODE ??
  'auto') as NonNullable<Options['permissionMode']>

export type WorkerOptions = {
  model?: string
  /** Defaults to 'auto'. See DEFAULT_PERMISSION_MODE. */
  permissionMode?: Options['permissionMode']
  /**
   * Builds the permission handler for a turn. It is per-turn rather than
   * global because the prompt has to be posted into the thread that triggered
   * it, and the callback itself carries no conversation context.
   */
  canUseToolFor?: (ctx: TurnContext) => Options['canUseTool']
}

export function makeClaudeResponder(workerOpts: WorkerOptions = {}): Responder {
  return async (ctx: TurnContext): Promise<ResponderResult> => {
    const canUseTool = workerOpts.canUseToolFor?.(ctx)
    const options: Options = {
      cwd: ctx.cwd,
      // Keep Claude Code's own system prompt and append to it, rather than
      // replacing it — the worker should behave like a normal session.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
      // Load the user's CLAUDE.md and settings so the worker behaves like the
      // operator's own sessions. Note this also means their hooks run.
      settingSources: ['user', 'project'],
      // Per-thread overrides beat the daemon default, so /model and
      // /permissions take effect on the very next message.
      permissionMode: (ctx.permissionMode ??
        workerOpts.permissionMode ??
        DEFAULT_PERMISSION_MODE) as NonNullable<Options['permissionMode']>,
      ...(ctx.abort ? { abortController: ctx.abort } : {}),
      ...(ctx.sessionId ? { resume: ctx.sessionId } : {}),
      ...(ctx.model ?? workerOpts.model ? { model: ctx.model ?? workerOpts.model } : {}),
      ...(canUseTool ? { canUseTool, permissionPrompts: 'host' as const } : {}),
    }

    let finalText = ''
    let sessionId: string | undefined
    let compaction: Compaction | undefined
    let lastText = ''

    try {
      for await (const message of query({ prompt: ctx.turn.content, options })) {
        const outcome = consume(message, ctx, lastText)
        if (outcome.assistantText) lastText = outcome.assistantText
        if (outcome.sessionId) sessionId = outcome.sessionId
        if (outcome.compaction) compaction = outcome.compaction
        if (outcome.text !== undefined) finalText = outcome.text
        if (outcome.result) {
          // A command that succeeded silently is not a failure.
          if (outcome.result.kind === 'error' && compaction) {
            return { kind: 'reply', text: describeCompaction(compaction), sessionId }
          }
          // Only a reply carries a session id; retry/error results have no
          // room for one, and the id is already persisted by then anyway.
          return outcome.result.kind === 'reply'
            ? { ...outcome.result, sessionId: sessionId ?? outcome.result.sessionId }
            : outcome.result
        }
      }
    } catch (err) {
      const retry = retryAfterFrom(err)
      if (retry !== null) {
        return { kind: 'retry', afterMs: retry, reason: 'rate limited' }
      }
      // An abort is /stop, not a crash: say so plainly.
      if (ctx.abort?.signal.aborted) return { kind: 'error', message: 'Stopped.' }
      return { kind: 'error', message: describe(err) }
    }

    // The stream ended without a result message — treat as a failure rather
    // than posting nothing, so the turn is visibly settled either way.
    if (!finalText.trim()) {
      if (compaction) return { kind: 'reply', text: describeCompaction(compaction), sessionId }
      return { kind: 'error', message: 'the model produced no reply' }
    }
    return { kind: 'reply', text: finalText, sessionId }
  }
}

export type Compaction = { preTokens: number; postTokens?: number; durationMs?: number }

type Consumed = {
  sessionId?: string
  text?: string
  compaction?: Compaction
  /** Text of an assistant message, kept in case the final result is empty. */
  assistantText?: string
  result?: ResponderResult
}

/**
 * Compaction reports itself and returns nothing.
 *
 * Claude Code's `/compact` is handled by the CLI, not the model, and it
 * completes with an *empty* result string. Left alone that trips the
 * "produced no reply" path and the thread gets an error for a command that
 * actually succeeded — so the boundary event is turned into the answer.
 */
export function describeCompaction(c: Compaction): string {
  const parts = [`🗜️ Compacted this conversation.`]
  if (typeof c.postTokens === 'number') {
    const saved = c.preTokens - c.postTokens
    parts.push(
      `${c.preTokens.toLocaleString()} → ${c.postTokens.toLocaleString()} tokens ` +
        `(${saved.toLocaleString()} dropped).`,
    )
  } else {
    parts.push(`Was ${c.preTokens.toLocaleString()} tokens.`)
  }
  if (typeof c.durationMs === 'number') parts.push(`Took ${(c.durationMs / 1000).toFixed(1)}s.`)
  return parts.join(' ')
}

export function consume(message: SDKMessage, ctx: TurnContext, lastText = ''): Consumed {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const meta = message.compact_metadata
    return {
      compaction: {
        preTokens: meta.pre_tokens,
        postTokens: meta.post_tokens,
        durationMs: meta.duration_ms,
      },
    }
  }

  if (message.type === 'assistant') {
    // Surface tool activity as a live status line while the turn runs.
    const texts: string[] = []
    for (const block of message.message.content) {
      if (typeof block === 'object' && block !== null && 'type' in block) {
        if (block.type === 'tool_use' && 'name' in block) {
          ctx.onToolUse?.(String(block.name))
        }
        if (block.type === 'text' && 'text' in block) texts.push(String(block.text))
      }
    }
    const assistantText = texts.join('\n').trim()
    return assistantText ? { assistantText } : {}
  }

  if (message.type !== 'result') return {}

  const sessionId = message.session_id

  if (message.subtype === 'success') {
    // 429 arrives as a successful stream carrying an error status.
    if (message.api_error_status === 429) {
      return { sessionId, result: { kind: 'retry', afterMs: DEFAULT_RETRY_MS, reason: 'rate limited' } }
    }
    // `result` is only the *last* assistant message. When the model writes its
    // answer and then ends on a tool call or a thinking-only message, it is
    // empty even though the answer exists; post the last text instead.
    const text = message.result?.trim() || lastText
    if (!text) {
      return { sessionId, result: { kind: 'error', message: 'the model produced no reply' } }
    }
    return {
      sessionId,
      text,
      result: {
        kind: 'reply',
        text,
        sessionId,
        usage: {
          costUsd: message.total_cost_usd,
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
          durationMs: message.duration_ms,
        },
      },
    }
  }

  return { sessionId, result: { kind: 'error', message: describeResultError(message.subtype) } }
}

function describeResultError(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'the model hit its turn limit before finishing'
    case 'error_max_budget_usd':
      return 'the model hit its cost budget before finishing'
    case 'error_during_execution':
      return 'the model errored mid-turn'
    default:
      return `the model stopped: ${subtype}`
  }
}

/**
 * Pull a retry delay out of a rate-limit error. Anything else returns null and
 * is treated as a real failure.
 */
function retryAfterFrom(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: number; headers?: Record<string, string>; message?: string }
  const is429 = e.status === 429 || /\b429\b|rate limit/i.test(e.message ?? '')
  if (!is429) return null
  const header = e.headers?.['retry-after']
  const seconds = header ? Number(header) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export const claudeResponder: Responder = makeClaudeResponder()
