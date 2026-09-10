/**
 * In-thread commands.
 *
 * A message starting with `/` is handled here and never reaches the model, so
 * these cost nothing and always answer.
 *
 * Several mirror Claude Code's own slash commands. `/usage`, `/context` and
 * `/model` read the same structured data the CLI's commands read, via SDK
 * control requests that boot the CLI without ever submitting a turn.
 *
 * `/compact` is the exception: it is advertised in `/help` but handled *by the
 * CLI itself*, so it merely has to reach the worker untouched. It is also the
 * one advertised command that is not free, since compaction is a real
 * summarisation call.
 *
 * Commands that are inherently interactive or terminal-bound — `/config`,
 * `/vim`, `/doctor`, `/login`, `/resume` — have no sensible Discord
 * translation and are deliberately absent.
 *
 * These are plain text, not Discord application commands. Registering real
 * slash commands would need an application-command scope and a deploy step, and
 * would expose the whole surface to everyone in the guild.
 */

import { statSync } from 'fs'
import type { Client } from 'discord.js'
import type { Repo } from '../store/repo'
import { availableModels, contextUsage, planUsage } from '../engine/control'
import { syncModelHeader } from './threads'
import { DEFAULT_CWD } from '../config'
import { log, describeError } from '../log'

export type CommandOutcome = { handled: false } | { handled: true; reply: string }

export type CommandContext = {
  client: Client
  repo: Repo
  conversationId: string
  /** Cancels a running turn; supplied by the daemon. */
  interrupt?: (conversationId: string) => boolean
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk'] as const

const HELP = [
  '**Thread**',
  '`/status` — session, model, directory, turns',
  '`/cwd [path]` — show or change this thread’s working directory',
  '`/clear` — forget the conversation, keep the thread',
  '`/stop` — cancel the turn that is running',
  '`/done` — archive this thread',
  '',
  '**Claude**',
  '`/usage` — plan limits: 5-hour and weekly windows',
  '`/cost` — what this thread has spent',
  '`/context` — context window used by this conversation',
  '`/model [name]` — show, list or set the model for this thread',
  '`/model global [name]` — the model every new thread starts on',
  '_(outside a thread, `/model` is `/model global` — there is no thread to set)_',
  '`/permissions [mode]` — show or set the permission mode',
  '`/compact` — summarise this conversation to free up context _(costs tokens)_',
  '',
  '**Elsewhere**',
  '`/threads` — every open thread',
  '',
  'Anything else is a message for Claude.',
].join('\n')

export async function handleCommand(raw: string, ctx: CommandContext): Promise<CommandOutcome> {
  const text = raw.trim()
  if (!text.startsWith('/')) return { handled: false }

  const [word, ...rest] = text.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  const command = (word ?? '').toLowerCase()

  switch (command) {
    case 'help':
      return reply(HELP)
    case 'status':
      return reply(status(ctx))
    case 'cwd':
      return reply(cwd(ctx, arg))
    case 'clear':
      return reply(clear(ctx))
    case 'stop':
      return reply(stop(ctx))
    case 'done':
      return reply(await done(ctx))
    case 'usage':
      return reply(await usage(ctx))
    case 'cost':
      return reply(cost(ctx))
    case 'context':
      return reply(await context(ctx))
    case 'model':
      return reply(await model(ctx, arg))
    case 'permissions':
    case 'permission':
      return reply(permissions(ctx, arg))
    case 'threads':
      return reply(threads(ctx))
    // /compact is deliberately absent from this switch. Claude Code's own CLI
    // intercepts it before the model, so it only has to reach the worker —
    // handling it here would replace a working implementation with a worse
    // one. It is the one command in /help that is not free.
    default:
      // Unknown slashes fall through to the model rather than erroring — the
      // user may genuinely have meant "/foo" as prose.
      return { handled: false }
  }
}

const reply = (text: string): CommandOutcome => ({ handled: true, reply: text })
const NO_THREAD =
  'This is about a single conversation, and there is no conversation here yet — ' +
  'send a message to start a thread, then run it in there.'

function status(ctx: CommandContext): string {
  const thread = ctx.repo.getThread(ctx.conversationId)
  if (!thread) return NO_THREAD
  const turns = ctx.repo.turnCount(ctx.conversationId)
  return [
    `**state** ${thread.state}`,
    `**cwd** \`${thread.cwd}\``,
    `**model** ${thread.model ?? 'account default'}`,
    `**new threads** ${ctx.repo.defaultModel() ?? 'account default'}`,
    `**permissions** ${thread.permission_mode ?? 'auto'}`,
    `**session** \`${thread.cc_session_id ?? 'not started'}\``,
    `**turns** ${turns.done} done, ${turns.failed} failed, ${turns.open} open`,
  ].join('\n')
}

function cwd(ctx: CommandContext, arg: string): string {
  const thread = ctx.repo.getThread(ctx.conversationId)
  if (!thread) return NO_THREAD
  if (!arg) return `Working directory is \`${thread.cwd}\`.\nChange it with \`/cwd /path/to/repo\`.`

  const path = arg.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
  try {
    if (!statSync(path).isDirectory()) return `\`${path}\` is not a directory.`
  } catch {
    return `\`${path}\` does not exist.`
  }
  ctx.repo.setThreadCwd(ctx.conversationId, path)
  return `Working directory set to \`${path}\`. The conversation continues; only new commands run there.`
}

function clear(ctx: CommandContext): string {
  const thread = ctx.repo.getThread(ctx.conversationId)
  if (!thread) return NO_THREAD
  if (!thread.cc_session_id) return 'Nothing to clear — this thread has no conversation yet.'
  ctx.repo.clearThreadSession(ctx.conversationId)
  // The thread and its Discord history stay; only Claude's memory of it goes.
  return 'Cleared. The next message starts a fresh conversation in this thread.'
}

function stop(ctx: CommandContext): string {
  const stopped = ctx.interrupt?.(ctx.conversationId) ?? false
  return stopped ? 'Stopping the current turn.' : 'Nothing is running in this thread.'
}

async function done(ctx: CommandContext): Promise<string> {
  ctx.repo.archiveThread(ctx.conversationId)
  try {
    const ch = await ctx.client.channels.fetch(ctx.conversationId)
    if (ch?.isThread()) {
      await ch.setArchived(true)
      return 'Archived. Post here again to reopen it.'
    }
    return 'Marked done. This is a DM, so there is no thread to archive.'
  } catch (err) {
    log.warn('archive failed', { conversationId: ctx.conversationId, error: describeError(err) })
    return (
      'Marked done in my records, but Discord refused to archive the thread — ' +
      'the bot needs the **Manage Threads** permission for that.'
    )
  }
}

/** Percent bar, because a number alone is hard to read on a phone. */
function bar(pct: number | null): string {
  if (pct === null) return '—'
  const filled = Math.round(Math.min(100, Math.max(0, pct)) / 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(pct)}%`
}

function resetsIn(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const hours = Math.floor(ms / 3_600_000)
  const mins = Math.round((ms % 3_600_000) / 60_000)
  return hours > 0 ? ` · resets in ${hours}h ${mins}m` : ` · resets in ${mins}m`
}

async function usage(ctx: CommandContext): Promise<string> {
  const thread = ctx.repo.getThread(ctx.conversationId)
  const plan = await planUsage(thread?.cwd ?? process.env.HOME ?? '/')
  if (!plan) return 'Plan usage is unavailable right now.'
  if (!plan.available) {
    return 'Plan rate limits do not apply to this account (API key or third-party provider).'
  }

  const lines = [`**Plan** ${plan.subscriptionType ?? 'unknown'}`]
  if (plan.fiveHour) {
    lines.push(`**5-hour** ${bar(plan.fiveHour.utilization)}${resetsIn(plan.fiveHour.resets_at)}`)
  }
  if (plan.sevenDay) {
    lines.push(`**Weekly** ${bar(plan.sevenDay.utilization)}${resetsIn(plan.sevenDay.resets_at)}`)
  }
  for (const m of plan.modelScoped) {
    lines.push(`**${m.display_name}** ${bar(m.utilization)}${resetsIn(m.resets_at)}`)
  }
  return lines.join('\n')
}

function cost(ctx: CommandContext): string {
  const totals = ctx.repo.threadUsage(ctx.conversationId)
  if (totals.turns === 0) return 'No completed turns in this thread yet.'
  const tokens = totals.inputTokens + totals.outputTokens
  return [
    `**${totals.turns}** turn${totals.turns === 1 ? '' : 's'} in this thread`,
    `**$${totals.costUsd.toFixed(4)}** estimated`,
    `**${tokens.toLocaleString()}** tokens (${totals.inputTokens.toLocaleString()} in, ` +
      `${totals.outputTokens.toLocaleString()} out)`,
    '',
    '_An estimate from the SDK, not a billing statement._',
  ].join('\n')
}

async function context(ctx: CommandContext): Promise<string> {
  const thread = ctx.repo.getThread(ctx.conversationId)
  if (!thread) return NO_THREAD
  if (!thread.cc_session_id) return 'No conversation in this thread yet.'

  const usage = await contextUsage(thread.cwd, thread.cc_session_id)
  if (!usage || usage.used === null) return 'Context usage is unavailable for this conversation.'
  const pct = usage.total ? (usage.used / usage.total) * 100 : null
  return [
    `**Context** ${usage.used.toLocaleString()}` +
      (usage.total ? ` / ${usage.total.toLocaleString()} tokens` : ' tokens'),
    pct !== null ? bar(pct) : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Words that mean "stop overriding and fall back". */
const RESET_WORDS = ['default', 'reset', 'none', 'clear']

/**
 * Resolve what the user typed to a model value.
 *
 * An exact value or a casually typed display name ("opus") both work. If the
 * list is unavailable — the control session failed — the raw string is taken
 * on trust rather than blocking a legitimate change on a transient failure.
 */
async function resolveModelArg(
  cwd: string,
  arg: string,
): Promise<{ value: string } | { error: string }> {
  const models = await availableModels(cwd)
  const match =
    models.find(m => m.value.toLowerCase() === arg.toLowerCase()) ??
    models.find(m => m.displayName.toLowerCase() === arg.toLowerCase())
  if (models.length > 0 && !match) {
    return { error: `Unknown model \`${arg}\`. Run \`/model list\` to see the options.` }
  }
  return { value: match?.value ?? arg }
}

async function model(ctx: CommandContext, arg: string): Promise<string> {
  const raw = arg.trim()
  const lower = raw.toLowerCase()

  // `global` is answered before the thread lookup, so it also works from a
  // channel that has no conversation yet — which is exactly where you would
  // set the default for the threads that channel is about to spawn.
  if (lower === 'global' || lower.startsWith('global ')) {
    return await globalModel(ctx, raw.slice('global'.length).trim())
  }

  // A channel has no conversation of its own, so there is no thread model to
  // show or set there — the only model setting that means anything is the one
  // new threads open on. Answering that beats an error about a thread the user
  // never asked about.
  const thread = ctx.repo.getThread(ctx.conversationId)
  if (!thread) return await globalModel(ctx, raw)
  const fallback = ctx.repo.defaultModel()

  if (!raw || lower === 'list') {
    const models = await availableModels(thread.cwd)
    const current = [
      `Model for this thread: **${thread.model ?? 'account default'}**`,
      `New threads start on: **${fallback ?? 'account default'}**`,
    ].join('\n')
    if (models.length === 0) return `${current}\nCould not list available models right now.`
    const list = models.map(m => `\`${m.value}\` — ${m.displayName}`).join('\n')
    return (
      `${current}\n\n${list}\n\n` +
      'Set this thread with `/model <name>`, or every new thread with `/model global <name>`.'
    )
  }

  // Resetting a thread returns it to the global default, not past it: the
  // global setting is the thing an operator configured on purpose.
  if (RESET_WORDS.includes(lower)) {
    ctx.repo.setThreadModel(ctx.conversationId, fallback)
    await refreshHeader(ctx)
    return fallback
      ? `Model reset to the default for new threads, \`${fallback}\`.`
      : 'Model reset to the account default for this thread.'
  }

  const resolved = await resolveModelArg(thread.cwd, raw)
  if ('error' in resolved) return resolved.error
  ctx.repo.setThreadModel(ctx.conversationId, resolved.value)
  await refreshHeader(ctx)
  return `Model set to \`${resolved.value}\` for this thread, starting with the next message.`
}

/**
 * The model new threads start on.
 *
 * It is a starting point, not a live binding: an open thread keeps whatever it
 * was opened with, so changing this cannot silently move a conversation onto a
 * different model mid-way.
 */
async function globalModel(ctx: CommandContext, arg: string): Promise<string> {
  const current = ctx.repo.defaultModel()
  const raw = arg.trim()
  const lower = raw.toLowerCase()

  if (!raw || lower === 'list') {
    const models = await availableModels(ctx.repo.getThread(ctx.conversationId)?.cwd ?? DEFAULT_CWD)
    const head = `New threads start on: **${current ?? 'account default'}**`
    if (models.length === 0) return `${head}\nCould not list available models right now.`
    const list = models.map(m => `\`${m.value}\` — ${m.displayName}`).join('\n')
    return `${head}\n\n${list}\n\nSet it with \`/model global <name>\`.`
  }

  if (RESET_WORDS.includes(lower)) {
    ctx.repo.setDefaultModel(null)
    return 'New threads will use the account default. Open threads keep theirs.'
  }

  const resolved = await resolveModelArg(
    ctx.repo.getThread(ctx.conversationId)?.cwd ?? DEFAULT_CWD,
    raw,
  )
  if ('error' in resolved) return resolved.error
  ctx.repo.setDefaultModel(resolved.value)
  return (
    `New threads will start on \`${resolved.value}\`. ` +
    'Open threads keep the model they were opened with — use `/model <name>` to move one.'
  )
}

/** Keep the thread's banner honest after a change. Cosmetic, never fatal. */
async function refreshHeader(ctx: CommandContext): Promise<void> {
  try {
    await syncModelHeader(ctx.client, ctx.repo, ctx.conversationId)
  } catch (err) {
    log.debug('could not update model header', {
      conversationId: ctx.conversationId,
      error: describeError(err),
    })
  }
}

function permissions(ctx: CommandContext, arg: string): string {
  const thread = ctx.repo.getThread(ctx.conversationId)
  if (!thread) return NO_THREAD

  if (!arg) {
    return [
      `Permission mode for this thread: **${thread.permission_mode ?? 'auto'}**`,
      '',
      '`auto` — a classifier approves routine calls, risky ones become buttons',
      '`default` — ask before every tool call',
      '`acceptEdits` — auto-accept file edits, ask for the rest',
      '`plan` — plan only, run nothing',
      '`dontAsk` — never ask; deny anything not pre-approved',
    ].join('\n')
  }

  const mode = PERMISSION_MODES.find(m => m.toLowerCase() === arg.toLowerCase())
  if (!mode) {
    return `Unknown mode \`${arg}\`. One of: ${PERMISSION_MODES.map(m => `\`${m}\``).join(', ')}.`
  }
  // bypassPermissions is intentionally not offered: granting it from a chat
  // message would remove the approval path that the buttons exist to provide.
  ctx.repo.setThreadPermissionMode(ctx.conversationId, mode)
  return `Permission mode set to \`${mode}\` for this thread, starting with the next message.`
}

function threads(ctx: CommandContext): string {
  const open = ctx.repo.openThreads()
  if (open.length === 0) return 'No open threads.'
  const lines = open.slice(0, 20).map(t => {
    const when = new Date(t.last_active_at).toISOString().replace('T', ' ').slice(0, 16)
    const here = t.thread_id === ctx.conversationId ? ' ← here' : ''
    return `<#${t.thread_id}> · ${when}${here}`
  })
  if (open.length > 20) lines.push(`_…and ${open.length - 20} more_`)
  return lines.join('\n')
}
