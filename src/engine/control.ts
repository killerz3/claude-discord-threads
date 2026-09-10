/**
 * Deterministic answers from Claude Code, without a model turn.
 *
 * Several of Claude Code's own slash commands are pure data — `/usage` reads
 * plan rate limits, `/context` reads the context window, `/model` lists what is
 * available. The SDK exposes those as *control requests*, which are only
 * available in streaming-input mode.
 *
 * So this opens a query whose prompt is a stream that never yields. The CLI
 * boots, answers the control request, and is closed. No user turn is ever
 * submitted, so no tokens are spent — the cost is a process spawn of a second
 * or two, which is why the results get cached briefly.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { log, describeError } from '../log'

/** A prompt that never produces a message, so the CLI idles awaiting input. */
async function* silent(): AsyncGenerator<never> {
  await new Promise<never>(() => {})
}

/**
 * Run one control request against a short-lived session.
 *
 * `resume` targets an existing conversation, which is what makes `/context`
 * meaningful per thread.
 */
export async function withControlSession<T>(
  options: Options,
  fn: (q: Awaited<ReturnType<typeof query>>) => Promise<T>,
): Promise<T> {
  const q = query({ prompt: silent(), options })
  try {
    return await fn(q)
  } finally {
    q.close()
  }
}

export type PlanWindow = { utilization: number | null; resets_at: string | null }

export type PlanUsage = {
  subscriptionType: string | null
  available: boolean
  fiveHour?: PlanWindow | null
  sevenDay?: PlanWindow | null
  modelScoped: Array<{ display_name: string; utilization: number | null; resets_at: string | null }>
}

/**
 * The data behind Claude Code's `/usage`.
 *
 * The SDK method name shouts that it is experimental and will change, so it is
 * called defensively and through a cast: a rename should degrade this one
 * command, not break the daemon. Cached because each call spawns a CLI.
 */
let usageCache: { at: number; value: PlanUsage } | null = null
const USAGE_TTL_MS = 60_000

export async function planUsage(cwd: string): Promise<PlanUsage | null> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value
  try {
    const raw = await withControlSession({ cwd }, async q => {
      const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
      const fn = (q as unknown as Record<string, unknown>)[method]
      if (typeof fn !== 'function') throw new Error(`SDK no longer exposes ${method}`)
      return (await (fn as (o: unknown) => Promise<unknown>).call(q, {
        skipBehaviors: true,
      })) as Record<string, never>
    })

    const limits = (raw as { rate_limits?: Record<string, unknown> }).rate_limits ?? {}
    const value: PlanUsage = {
      subscriptionType: (raw as { subscription_type?: string | null }).subscription_type ?? null,
      available: Boolean((raw as { rate_limits_available?: boolean }).rate_limits_available),
      fiveHour: (limits.five_hour ?? null) as PlanWindow | null,
      sevenDay: (limits.seven_day ?? null) as PlanWindow | null,
      modelScoped: (limits.model_scoped ?? []) as PlanUsage['modelScoped'],
    }
    usageCache = { at: Date.now(), value }
    return value
  } catch (err) {
    log.warn('plan usage unavailable', { error: describeError(err) })
    return null
  }
}

export type ModelChoice = { value: string; displayName: string; description?: string }

let modelCache: { at: number; value: ModelChoice[] } | null = null
const MODEL_TTL_MS = 10 * 60_000

export async function availableModels(cwd: string): Promise<ModelChoice[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.value
  try {
    const models = await withControlSession({ cwd }, q => q.supportedModels())
    const value = models.map(m => ({
      value: String((m as { value?: string }).value ?? ''),
      displayName: String((m as { displayName?: string }).displayName ?? ''),
      description: (m as { description?: string }).description,
    }))
    modelCache = { at: Date.now(), value }
    return value
  } catch (err) {
    log.warn('model list unavailable', { error: describeError(err) })
    return []
  }
}

/**
 * Display name for a model value, but only if the list is already cached.
 *
 * The thread header is written on the hot path of thread creation, and
 * spawning a CLI to prettify one line is not worth the latency — an unadorned
 * model id is a fine fallback.
 */
export function cachedModelDisplayName(value: string): string | null {
  return modelCache?.value.find(m => m.value === value)?.displayName || null
}

export type ContextUsage = { used: number | null; total: number | null }

/**
 * Context-window usage for one conversation. `summary` answers from the last
 * response rather than re-counting every category, which keeps it free.
 */
export async function contextUsage(cwd: string, sessionId: string): Promise<ContextUsage | null> {
  try {
    return await withControlSession({ cwd, resume: sessionId }, async q => {
      const raw = (await q.getContextUsage({ detail: 'summary' })) as unknown as Record<
        string,
        unknown
      >
      const total =
        num(raw.contextWindow) ?? num(raw.context_window) ?? num(raw.maxTokens) ?? null
      const used = num(raw.totalTokens) ?? num(raw.total_tokens) ?? num(raw.used) ?? null
      return { used, total }
    })
  } catch (err) {
    log.warn('context usage unavailable', { session: sessionId, error: describeError(err) })
    return null
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
