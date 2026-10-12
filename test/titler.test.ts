/**
 * Thread naming.
 *
 * The properties that matter: a rename happens only when due, a name the owner
 * typed by hand is never overwritten, and a model answer that does not read as
 * a name is dropped rather than shown in the sidebar.
 */

import { test, expect, describe } from 'bun:test'
import type { Client } from 'discord.js'
import { openDb } from '../src/store/db'
import { Repo } from '../src/store/repo'
import { handleCommand } from '../src/discord/commands'
import { autoName, parseTitle, ownWords, messagesForTitle } from '../src/engine/titler'
import { threadName } from '../src/discord/util'

function setup(opts: { name?: string; title?: string | null; doneTurns?: number } = {}) {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  repo.createThread({
    thread_id: 'thread-1',
    channel_id: 'chan-1',
    root_message_id: 'msg-1',
    guild_id: 'guild-1',
    cc_session_id: null,
    cwd: '/home/agent',
    title: opts.title === undefined ? 'can you look at the boost ads for RaR' : opts.title,
    state: 'open',
    model: null,
    permission_mode: null,
    header_message_id: null,
  })
  for (let i = 0; i < (opts.doneTurns ?? 1); i++) {
    const t = repo.enqueueTurn({ threadId: 'thread-1', inboundMessageId: `m${i}`, authorId: 'u', content: `msg ${i}` })!
    repo.finishTurn(t.id, [`r${i}`])
  }

  const channel = {
    name: opts.name ?? 'can you look at the boost ads for RaR',
    isThread: () => true,
    setName: async (n: string) => {
      channel.name = n
      renames.push(n)
    },
  }
  const renames: string[] = []
  const client = { channels: { fetch: async () => channel } } as unknown as Client
  const asked: string[][] = []
  const suggest = async (_current: string, messages: string[]) => {
    asked.push(messages)
    return 'RaR Boost Ads'
  }
  const addTurns = (n: number) => {
    const base = repo.turnCount('thread-1').done
    for (let i = 0; i < n; i++) {
      const t = repo.enqueueTurn({ threadId: 'thread-1', inboundMessageId: `x${base + i}`, authorId: 'u', content: 'more' })!
      repo.finishTurn(t.id, ['r'])
    }
  }
  return { repo, client, channel, renames, suggest, asked, addTurns }
}

describe('parseTitle', () => {
  test('strips quotes and trailing punctuation', () => {
    expect(parseTitle('"TRPhoto Boost Ads."')).toBe('TRPhoto Boost Ads')
    expect(parseTitle('  “just1.page ie”  ')).toBe('just1.page ie')
  })

  test('rejects empty and over-long answers', () => {
    expect(parseTitle('')).toBeNull()
    expect(parseTitle('""')).toBeNull()
    expect(parseTitle('one two three four five six seven eight')).toBeNull()
    expect(parseTitle('x'.repeat(61))).toBeNull()
  })

  test('rejects a style example echoed back', () => {
    expect(parseTitle('royalties')).toBeNull()
  })
})

describe('autoName', () => {
  test('names a thread never named before, from its recent messages', async () => {
    const { repo, client, renames, suggest, asked } = setup()
    await autoName(client, repo, 'thread-1', suggest)
    expect(renames).toEqual(['RaR Boost Ads'])
    expect(asked[0]).toEqual(['msg 0'])
    expect(repo.getThread('thread-1')).toMatchObject({ title: 'RaR Boost Ads', named_turns: 1 })
  })

  test('waits six done turns before renaming again', async () => {
    const { repo, client, renames, addTurns } = setup()
    let next = 'First'
    const suggest = async () => next
    await autoName(client, repo, 'thread-1', suggest)
    next = 'Second'
    addTurns(5)
    await autoName(client, repo, 'thread-1', suggest)
    expect(renames).toEqual(['First'])
    addTurns(1)
    await autoName(client, repo, 'thread-1', suggest)
    expect(renames).toEqual(['First', 'Second'])
    expect(repo.getThread('thread-1')?.named_turns).toBe(7)
  })

  test('keeps a name the owner typed by hand', async () => {
    const { repo, client, renames, suggest, asked } = setup({ name: 'Royalties' })
    await autoName(client, repo, 'thread-1', suggest)
    expect(renames).toEqual([])
    expect(asked).toHaveLength(0)
    expect(repo.getThread('thread-1')).toMatchObject({ title: 'Royalties', named_turns: 1 })
  })

  test('only our own truncation of the opening message counts as ours', async () => {
    const long = 'please '.repeat(30).trim()
    const { repo, client, renames, suggest } = setup({ title: long, name: long.slice(0, 80) })
    // Not threadName(long): a name we did not produce counts as his.
    await autoName(client, repo, 'thread-1', suggest)
    expect(renames).toEqual([])

    const ours = setup({ title: long, name: threadName(long) })
    await autoName(ours.client, ours.repo, 'thread-1', ours.suggest)
    expect(ours.renames).toEqual(['RaR Boost Ads'])
  })

  test('the same name in another case is not a rename, but still counts', async () => {
    const { repo, client, renames } = setup({ name: 'rar boost ads', title: 'rar boost ads' })
    await autoName(client, repo, 'thread-1', async () => 'RaR Boost Ads')
    expect(renames).toEqual([])
    expect(repo.getThread('thread-1')?.named_turns).toBe(1)
  })

  test('no suggestion means no rename', async () => {
    const { repo, client, renames } = setup()
    await autoName(client, repo, 'thread-1', async () => null)
    expect(renames).toEqual([])
  })

  test('a Discord refusal is logged, not thrown', async () => {
    const { repo, client, channel, suggest } = setup()
    channel.setName = async () => {
      throw new Error('Missing Permissions')
    }
    await autoName(client, repo, 'thread-1', suggest)
    expect(repo.getThread('thread-1')?.named_turns).toBeNull()
  })
})

describe('/rename', () => {
  const ctxOf = (s: ReturnType<typeof setup>) => ({
    client: s.client,
    repo: s.repo,
    conversationId: 'thread-1',
    suggestTitle: s.suggest,
  })

  test('with a name, sets it now', async () => {
    const s = setup({ doneTurns: 3 })
    const out = await handleCommand('/rename Pip Guides', ctxOf(s))
    expect(out.handled && out.reply).toContain('Pip Guides')
    expect(s.renames).toEqual(['Pip Guides'])
    expect(s.repo.getThread('thread-1')).toMatchObject({ title: 'Pip Guides', named_turns: 3 })
    expect(s.asked).toHaveLength(0)
  })

  test('without a name, applies a suggestion', async () => {
    const s = setup()
    const out = await handleCommand('/rename', ctxOf(s))
    expect(out.handled && out.reply).toContain('RaR Boost Ads')
    expect(s.renames).toEqual(['RaR Boost Ads'])
  })

  test('says so when there is no suggestion', async () => {
    const s = setup()
    const out = await handleCommand('/rename', { ...ctxOf(s), suggestTitle: async () => null })
    expect(out.handled && out.reply).toContain('/rename <name>')
    expect(s.renames).toEqual([])
  })
})

describe('his words only', () => {
  test('drops the quoted bot reply and links, keeps what he typed', () => {
    const msg = 'Replying to ClaudePip:\n> Post it **today at 14:00 SAST**.\n> I don\'t have a proven best hour.\nRewrite it up to 22 times https://x.com/a/status/1'
    expect(ownWords(msg)).toBe('Rewrite it up to 22 times')
  })

  test('a message that is only a quote leaves nothing', () => {
    expect(ownWords('Replying to ClaudePip: > Post it today at 14:00')).toBe('')
  })

  test('opening messages always count, alongside the latest ones', () => {
    const { repo } = setup({ doneTurns: 0 })
    const contents = ['Use this for our X marketing', ...Array.from({ length: 20 }, (_, i) => `later ${i}`)]
    contents.forEach((content, i) => {
      const t = repo.enqueueTurn({ threadId: 'thread-1', inboundMessageId: `x${i}`, authorId: 'u', content })!
      repo.finishTurn(t.id, [`rx${i}`])
    })
    const msgs = messagesForTitle(repo, 'thread-1')
    expect(msgs[0]).toBe('Use this for our X marketing')
    expect(msgs.at(-1)).toBe('later 19')
    expect(msgs).not.toContain('later 5')
  })
})
