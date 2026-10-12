/**
 * Short thread names, in the owner's style.
 *
 * A thread opens named after its first message, truncated — which is what the
 * sidebar then shows forever, even after the conversation has moved on. This
 * asks a small model for a 1-7 word name every few turns, and leaves alone any
 * thread the owner has renamed by hand.
 *
 * Every failure here is cosmetic: a thread keeps its old name and the turn
 * that triggered the rename is already delivered.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Client } from 'discord.js'
import type { Repo } from '../store/repo'
import { DEFAULT_CWD } from '../config'
import { threadName } from '../discord/util'
import { log, describeError } from '../log'

/** Done turns between automatic renames. */
export const RENAME_EVERY_TURNS = 6
// Haiku kept naming threads after one early detail or a misheard word.
const TITLE_MODEL = 'claude-sonnet-5'
const RECENT_MESSAGES = 12
/** The opening messages set the thread's direction, so they always count. */
const OPENING_MESSAGES = 3

export type Suggest = (current: string, messages: string[]) => Promise<string | null>

const STYLE_EXAMPLES = [
  'Pip Guides',
  'RaR Boost Ads',
  'Ben Mothupi',
  'Royalties',
  'Profiling Buyers',
  'Project Maps',
  'TRPhoto Ads',
  'just1.page uk/ie',
  'j1 SEO',
  'GT',
]

/**
 * Accept a model's answer only if it reads as a name. Anything else means no
 * rename — a bad name in the sidebar is worse than a long one. A style example
 * echoed back means the model had too little to go on (a thread about funnels
 * got named "Royalties").
 */
export function parseTitle(raw: string): string | null {
  const name = raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`*#“”‘’]+|[\s"'`*“”‘’.,;:!?]+$/g, '')
  const words = name.split(' ').filter(Boolean).length
  if (words < 1 || words > 7 || name.length > 60) return null
  if (STYLE_EXAMPLES.some(e => e.toLowerCase() === name.toLowerCase())) return null
  return name
}

/**
 * Only the owner's own words. A message that replies to the bot quotes it
 * ("Replying to …" plus "> " lines), and links are someone else's words too.
 */
export function ownWords(content: string): string {
  return content
    .split('\n')
    .filter(line => !/^\s*>/.test(line) && !/^\s*Replying to .+:\s*$/i.test(line))
    .join(' ')
    .replace(/^\s*Replying to [^:]+:\s*>.*$/is, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/Files attached to this Discord message.*$/is, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Opening messages plus the latest ones, oldest first, in his words only. */
export function messagesForTitle(repo: Repo, threadId: string): string[] {
  const opening = repo.openingMessages(threadId, OPENING_MESSAGES)
  const recent = repo.recentMessages(threadId, RECENT_MESSAGES)
  const all = [...opening, ...recent.filter(m => !opening.includes(m))]
  // Slash commands (/recap, /rename) are not part of the conversation.
  return all.filter(m => !m.trimStart().startsWith('/')).map(ownWords).filter(Boolean)
}

/** Ask a small model, no tools, one turn, what the thread is about now. */
export const suggestTitle: Suggest = async (current, messages) => {
  const prompt = [
    'Name this Discord thread. The owner names threads like this:',
    STYLE_EXAMPLES.map(e => `- ${e}`).join('\n'),
    '',
    'Short (usually 1-3 words, never more than 7): the topic, person or product.',
    'These are only his messages. Name the goal he is steering the thread towards,',
    'not a detail from one message. The first messages are context; name what the',
    'latest messages are steering towards, since names follow the conversation.',
    'Build the name from words he actually used (his abbreviations and brand names',
    'as written), not words of your own. Title Case otherwise.',
    'He dictates, so a word may be a sound-alike (e.g. "SOUL" for "SOL"); never',
    'build the name on one odd word.',
    'Reply with the name only: no quotes, no explanation.',
    '',
    'His messages, oldest first (the last five carry the most weight):',
    messages
      .map((m, i) => `${i >= messages.length - 5 ? '- LATEST: ' : '- '}${m.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
      .join('\n'),
  ].join('\n')

  try {
    const q = query({
      prompt,
      options: {
        cwd: DEFAULT_CWD,
        model: TITLE_MODEL,
        systemPrompt: 'You write short names for chat threads.',
        tools: [],
        maxTurns: 1,
        // No CLAUDE.md, hooks or session file: this is a one-line utility call.
        settingSources: [],
        persistSession: false,
      },
    })
    for await (const message of q) {
      if (message.type === 'result') {
        return message.subtype === 'success' ? parseTitle(message.result) : null
      }
    }
  } catch (err) {
    log.warn('title suggestion failed', { error: describeError(err) })
  }
  return null
}

/**
 * Set a thread's name in Discord and the ledger. `named_turns` records how far
 * the conversation had got, so the next automatic rename waits its turn.
 */
export async function applyName(
  client: Client,
  repo: Repo,
  threadId: string,
  name: string,
): Promise<string | null> {
  const ch = await client.channels.fetch(threadId)
  if (!ch?.isThread()) return null
  const title = threadName(name)
  if (ch.name !== title) await ch.setName(title)
  repo.setThreadNamed(threadId, title, repo.turnCount(threadId).done)
  return title
}

/** Suggest a name from the thread's recent messages and apply it. */
export async function renameFromSuggestion(
  client: Client,
  repo: Repo,
  threadId: string,
  suggest: Suggest = suggestTitle,
): Promise<string | null> {
  const ch = await client.channels.fetch(threadId)
  if (!ch?.isThread()) return null
  const name = await suggest(ch.name, messagesForTitle(repo, threadId))
  if (!name) return null
  return applyName(client, repo, threadId, name)
}

/**
 * Rename a thread if it is due: never named by this logic, or six done turns
 * since it last was. A name that is neither ours nor the opening message was
 * typed by the owner, so it is recorded and kept.
 */
export async function autoName(
  client: Client,
  repo: Repo,
  threadId: string,
  suggest: Suggest = suggestTitle,
): Promise<void> {
  const thread = repo.getThread(threadId)
  if (!thread || thread.guild_id === null || thread.state !== 'open') return
  const done = repo.turnCount(threadId).done
  if (done === 0) return
  if (thread.named_turns !== null && done - thread.named_turns < RENAME_EVERY_TURNS) return

  try {
    const ch = await client.channels.fetch(threadId)
    if (!ch?.isThread()) return
    if (thread.title !== null && ch.name !== thread.title && ch.name !== threadName(thread.title)) {
      repo.setThreadNamed(threadId, ch.name, done)
      return
    }
    const name = await suggest(ch.name, messagesForTitle(repo, threadId))
    if (name && name.toLowerCase() !== ch.name.toLowerCase()) {
      await applyName(client, repo, threadId, name)
    } else {
      repo.setThreadNamed(threadId, ch.name, done)
    }
  } catch (err) {
    // Renaming needs MANAGE_THREADS unless we own the thread, and Discord
    // allows two renames per thread per ten minutes.
    log.warn('auto naming failed', { thread: threadId, error: describeError(err) })
  }
}
