/**
 * In-thread commands.
 *
 * A message starting with `/` is handled here and never reaches the model, so
 * these cost nothing and always answer. They are deliberately few: anything
 * that needs judgement should just be asked in prose.
 *
 * Note these are plain text, not Discord application commands. Registering real
 * slash commands would need an application-command scope and a deploy step, and
 * would put the bot's whole command surface in front of everyone in the guild.
 */

import { statSync } from 'fs'
import type { Client } from 'discord.js'
import type { Repo } from '../store/repo'
import { log, describeError } from '../log'

export type CommandOutcome =
  | { handled: false }
  | { handled: true; reply: string }

const HELP = [
  '**Thread commands**',
  '`/help` — this list',
  '`/status` — session id, working directory, turns so far',
  '`/cwd [path]` — show, or change, the directory this thread works in',
  '`/done` — archive this thread',
  '',
  'Anything else is a message for Claude.',
].join('\n')

export async function handleCommand(
  raw: string,
  ctx: { client: Client; repo: Repo; conversationId: string },
): Promise<CommandOutcome> {
  const text = raw.trim()
  if (!text.startsWith('/')) return { handled: false }

  const [word, ...rest] = text.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  const command = (word ?? '').toLowerCase()

  switch (command) {
    case 'help':
      return { handled: true, reply: HELP }

    case 'status':
      return { handled: true, reply: status(ctx.repo, ctx.conversationId) }

    case 'cwd':
      return { handled: true, reply: cwd(ctx.repo, ctx.conversationId, arg) }

    case 'done':
      return { handled: true, reply: await done(ctx.client, ctx.repo, ctx.conversationId) }

    default:
      // Unknown slashes fall through to the model rather than erroring — the
      // user may genuinely have meant "/foo" as prose, and refusing would be
      // worse than answering.
      return { handled: false }
  }
}

function status(repo: Repo, conversationId: string): string {
  const thread = repo.getThread(conversationId)
  if (!thread) return 'No record of this thread yet — send a message first.'
  const turns = repo.turnCount(conversationId)
  return [
    `**state** ${thread.state}`,
    `**cwd** \`${thread.cwd}\``,
    `**session** \`${thread.cc_session_id ?? 'not started'}\``,
    `**turns** ${turns.done} done, ${turns.failed} failed, ${turns.open} open`,
  ].join('\n')
}

function cwd(repo: Repo, conversationId: string, arg: string): string {
  const thread = repo.getThread(conversationId)
  if (!thread) return 'No record of this thread yet — send a message first.'
  if (!arg) return `Working directory is \`${thread.cwd}\`.\nChange it with \`/cwd /path/to/repo\`.`

  const path = arg.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
  try {
    if (!statSync(path).isDirectory()) return `\`${path}\` is not a directory.`
  } catch {
    return `\`${path}\` does not exist.`
  }

  repo.setThreadCwd(conversationId, path)
  // The next turn resumes the same session with a new cwd; Claude Code handles
  // that, but say so, because it explains why earlier context still applies.
  return `Working directory set to \`${path}\`. The conversation continues; only new commands run there.`
}

async function done(client: Client, repo: Repo, conversationId: string): Promise<string> {
  repo.archiveThread(conversationId)
  try {
    const ch = await client.channels.fetch(conversationId)
    if (ch?.isThread()) {
      await ch.setArchived(true)
      return 'Archived. Post here again to reopen it.'
    }
    // DMs have no threads to archive, so this is bookkeeping only.
    return 'Marked done. This is a DM, so there is no thread to archive.'
  } catch (err) {
    log.warn('archive failed', { conversationId, error: describeError(err) })
    return (
      'Marked done in my records, but Discord refused to archive the thread — ' +
      'the bot needs the **Manage Threads** permission for that.'
    )
  }
}
