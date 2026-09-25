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

import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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

/**
 * How long a session may stay open after its last answer while background work
 * is still running. When it runs out the input closes, which kills the tasks.
 */
const BACKGROUND_HOLD_MS = Number(process.env.DISCORD_BACKGROUND_HOLD_MS ?? 2 * 60 * 60 * 1000)

/**
 * A session kept open after its turn because background work is still running.
 *
 * With a one-shot prompt the CLI kills background tasks (a `run_in_background`
 * command, a subagent, a Monitor) a few seconds after the result, so "I'll get
 * back to you when it's done" never happened. Keeping the input open lets the
 * task finish and wake the model; that later answer is posted to the thread.
 * New messages in the thread go into the same session instead of a second one.
 */
type LiveSession = {
  /** The turn the next result belongs to. Swapped as new turns arrive. */
  ctx: TurnContext
  push: (content: string) => void
  close: () => void
  waiter?: (r: ResponderResult) => void
  /** Non-ambient background tasks still running. */
  tasks: number
  hold?: ReturnType<typeof setTimeout>
}

export function makeClaudeResponder(workerOpts: WorkerOptions = {}): Responder {
  const live = new Map<string, LiveSession>()

  return async (ctx: TurnContext): Promise<ResponderResult> => {
    const existing = live.get(ctx.conversationId)
    if (existing) {
      clearTimeout(existing.hold)
      existing.ctx = ctx
      const reply = new Promise<ResponderResult>(r => (existing.waiter = r))
      existing.push(ctx.turn.content)
      return reply
    }

    // Closing over `session.ctx` rather than `ctx` keeps permission prompts
    // on the turn that is running now, not the one that opened the session.
    const canUseTool: Options['canUseTool'] | undefined = workerOpts.canUseToolFor
      ? (...args) => workerOpts.canUseToolFor!(session.ctx)!(...args)
      : undefined
    const abort = new AbortController()
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
      abortController: abort,
      ...(ctx.sessionId ? { resume: ctx.sessionId } : {}),
      ...(ctx.model ?? workerOpts.model ? { model: ctx.model ?? workerOpts.model } : {}),
      ...(canUseTool ? { canUseTool, permissionPrompts: 'host' as const } : {}),
    }

    const inbox = new Inbox()
    const session: LiveSession = {
      ctx,
      push: content => inbox.push(content),
      close: () => inbox.close(),
      tasks: 0,
    }
    live.set(ctx.conversationId, session)
    const reply = new Promise<ResponderResult>(r => (session.waiter = r))
    inbox.push(ctx.turn.content)
    void pump(session, query({ prompt: inbox.messages(), options }), abort).finally(() => {
      clearTimeout(session.hold)
      if (live.get(ctx.conversationId) === session) live.delete(ctx.conversationId)
    })
    return reply
  }
}

/** The session's input: user messages in, closed when nothing more is owed. */
class Inbox {
  private queue: string[] = []
  private wake?: () => void
  private closed = false

  push(content: string): void {
    this.queue.push(content)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const content = this.queue.shift()
      if (content !== undefined) {
        yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
        continue
      }
      if (this.closed) return
      await new Promise<void>(r => (this.wake = r))
      this.wake = undefined
    }
  }
}

/** Read the session until it ends, handing each result to its turn. */
async function pump(
  session: LiveSession,
  stream: AsyncIterable<SDKMessage>,
  abort: AbortController,
): Promise<void> {
  // /stop aborts the turn's own controller; forward it to the session.
  const forward = () => abort.abort()
  let linked = session.ctx.abort
  linked?.signal.addEventListener('abort', forward)

  let lastText = ''
  let sessionId: string | undefined
  let compaction: Compaction | undefined

  const settle = (result: ResponderResult) => {
    const waiter = session.waiter
    session.waiter = undefined
    if (waiter) return waiter(result)
    // Nobody is waiting: this is the model waking up after background work.
    const text = result.kind === 'reply' ? result.text : result.kind === 'error' ? `❌ ${result.message}` : ''
    if (text) void session.ctx.onLateReply?.(text)
  }

  try {
    for await (const message of stream) {
      if (session.ctx.abort !== linked) {
        linked?.signal.removeEventListener('abort', forward)
        linked = session.ctx.abort
        linked?.signal.addEventListener('abort', forward)
      }
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        session.tasks = message.tasks.filter(t => !t.ambient).length
        continue
      }

      const outcome = consume(message, session.ctx, lastText)
      if (outcome.assistantText) lastText = outcome.assistantText
      if (outcome.sessionId) sessionId = outcome.sessionId
      if (outcome.compaction) compaction = outcome.compaction
      if (!outcome.result) continue

      const result = outcome.result
      // A command that succeeded silently is not a failure.
      if (result.kind === 'error' && compaction) {
        settle({ kind: 'reply', text: describeCompaction(compaction), sessionId })
      } else {
        // Only a reply carries a session id; retry/error results have no
        // room for one, and the id is already persisted by then anyway.
        settle(result.kind === 'reply' ? { ...result, sessionId: sessionId ?? result.sessionId } : result)
      }
      lastText = ''
      compaction = undefined

      if (session.tasks === 0) {
        session.close()
      } else {
        session.hold = setTimeout(() => {
          if (session.waiter) return
          void session.ctx.onLateReply?.(
            `⏹️ Stopped waiting on background work after ${Math.round(BACKGROUND_HOLD_MS / 60000)} min.`,
          )
          session.close()
        }, BACKGROUND_HOLD_MS)
      }
    }
  } catch (err) {
    const retry = retryAfterFrom(err)
    if (retry !== null) return settle({ kind: 'retry', afterMs: retry, reason: 'rate limited' })
    // An abort is /stop, not a crash: say so plainly.
    if (abort.signal.aborted) return settle({ kind: 'error', message: 'Stopped.' })
    return settle({ kind: 'error', message: describe(err) })
  } finally {
    linked?.signal.removeEventListener('abort', forward)
  }

  // The stream ended without a result for the waiting turn — treat as a
  // failure rather than posting nothing, so the turn is visibly settled.
  if (session.waiter) settle({ kind: 'error', message: 'the model produced no reply' })
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
