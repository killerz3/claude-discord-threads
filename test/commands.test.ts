/**
 * In-thread commands.
 *
 * These bypass the model entirely, so the property that matters is that they
 * always answer and never leave a turn on the ledger. The interesting cases are
 * the boundaries: what counts as a command at all, and what happens when the
 * argument is wrong.
 */

import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Client } from 'discord.js'
import { openDb } from '../src/store/db'
import { Repo } from '../src/store/repo'
import { handleCommand } from '../src/discord/commands'

function setup(opts: { archived?: () => void; failArchive?: boolean } = {}) {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  repo.createThread({
    thread_id: 'thread-1',
    channel_id: 'chan-1',
    root_message_id: 'msg-1',
    guild_id: 'guild-1',
    cc_session_id: null,
    cwd: '/home/agent',
    title: null,
    state: 'open',
  })
  const client = {
    channels: {
      fetch: async () => ({
        isThread: () => true,
        setArchived: async () => {
          if (opts.failArchive) throw new Error('Missing Permissions')
          opts.archived?.()
        },
      }),
    },
  } as unknown as Client
  return { repo, client, ctx: { client, repo, conversationId: 'thread-1' } }
}

describe('dispatch', () => {
  test('plain prose is not a command', async () => {
    const { ctx } = setup()
    for (const text of ['hello', 'what is /done for?', 'fix the bug']) {
      expect((await handleCommand(text, ctx)).handled).toBe(false)
    }
  })

  test('an unknown slash falls through to the model rather than erroring', async () => {
    const { ctx } = setup()
    // "/foo" may well be prose; refusing would be worse than answering.
    expect((await handleCommand('/deploy the thing', ctx)).handled).toBe(false)
  })

  test('commands are recognised regardless of case and padding', async () => {
    const { ctx } = setup()
    for (const text of ['/help', '  /HELP  ', '/Help']) {
      expect((await handleCommand(text, ctx)).handled).toBe(true)
    }
  })
})

describe('/cwd', () => {
  test('with no argument it reports the current directory', async () => {
    const { ctx } = setup()
    const out = await handleCommand('/cwd', ctx)
    expect(out.handled && out.reply).toContain('/home/agent')
  })

  test('a valid directory is persisted', async () => {
    const { ctx, repo } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'cwd-'))
    const out = await handleCommand(`/cwd ${dir}`, ctx)

    expect(out.handled && out.reply).toContain(dir)
    expect(repo.getThread('thread-1')!.cwd).toBe(dir)
  })

  test('a path that does not exist is rejected and changes nothing', async () => {
    const { ctx, repo } = setup()
    const out = await handleCommand('/cwd /definitely/not/here', ctx)

    expect(out.handled && out.reply).toContain('does not exist')
    expect(repo.getThread('thread-1')!.cwd).toBe('/home/agent')
  })

  test('a file is rejected, since cwd must be a directory', async () => {
    const { ctx, repo } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'cwd-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')

    const out = await handleCommand(`/cwd ${file}`, ctx)
    expect(out.handled && out.reply).toContain('not a directory')
    expect(repo.getThread('thread-1')!.cwd).toBe('/home/agent')
  })

  test('a leading ~ is expanded', async () => {
    const { ctx, repo } = setup()
    const out = await handleCommand('/cwd ~', ctx)
    expect(out.handled).toBe(true)
    expect(repo.getThread('thread-1')!.cwd).toBe(process.env.HOME!)
  })
})

describe('/done', () => {
  test('archives the thread on both Discord and the ledger', async () => {
    let archived = false
    const { ctx, repo } = setup({ archived: () => (archived = true) })

    const out = await handleCommand('/done', ctx)

    expect(archived).toBe(true)
    expect(repo.getThread('thread-1')!.state).toBe('archived')
    expect(out.handled && out.reply).toContain('Archived')
  })

  test('a missing Manage Threads permission is explained, not swallowed', async () => {
    const { ctx, repo } = setup({ failArchive: true })

    const out = await handleCommand('/done', ctx)

    // The ledger still records intent, so the idle sweep will not keep retrying
    // a thread the user has finished with.
    expect(repo.getThread('thread-1')!.state).toBe('archived')
    expect(out.handled && out.reply).toContain('Manage Threads')
  })
})

describe('/status', () => {
  test('reports cwd, session and turn counts', async () => {
    const { ctx, repo } = setup()
    const t = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'm1',
      authorId: 'u',
      content: 'hi',
    })!
    repo.finishTurn(t.id, ['sent-1'])
    repo.setThreadSession('thread-1', 'sess-xyz')

    const out = await handleCommand('/status', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('sess-xyz')
    expect(reply).toContain('/home/agent')
    expect(reply).toContain('1 done')
  })
})

describe('idle sweep', () => {
  test('only open threads past the cutoff are returned, oldest first', () => {
    const { repo } = setup()
    repo.createThread({
      thread_id: 'thread-2',
      channel_id: 'chan-1',
      root_message_id: null,
      guild_id: 'guild-1',
      cc_session_id: null,
      cwd: '/home/agent',
      title: null,
      state: 'archived',
    })

    // Everything was just created, so nothing is stale yet.
    expect(repo.idleThreads(Date.now() - 60_000)).toHaveLength(0)
    // With a cutoff in the future, only the open thread qualifies.
    const stale = repo.idleThreads(Date.now() + 60_000)
    expect(stale.map(t => t.thread_id)).toEqual(['thread-1'])
  })
})
