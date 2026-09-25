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
import { consume, describeCompaction } from '../src/engine/worker'

function setup(
  opts: { archived?: () => void; failArchive?: boolean; running?: boolean } = {},
) {
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
    model: null,
    permission_mode: null,
    header_message_id: null,
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
  let interrupted: string | null = null
  const ctx = {
    client,
    repo,
    conversationId: 'thread-1',
    interrupt: (id: string) => {
      interrupted = id
      return opts.running ?? false
    },
  }
  return { repo, client, ctx, interrupted: () => interrupted }
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
      model: null,
      permission_mode: null,
      header_message_id: null,
    })

    // Everything was just created, so nothing is stale yet.
    expect(repo.idleThreads(Date.now() - 60_000)).toHaveLength(0)
    // With a cutoff in the future, only the open thread qualifies.
    const stale = repo.idleThreads(Date.now() + 60_000)
    expect(stale.map(t => t.thread_id)).toEqual(['thread-1'])
  })
})

describe('/clear', () => {
  test('drops the session but keeps the thread', async () => {
    const { ctx, repo } = setup()
    repo.setThreadSession('thread-1', 'sess-1')

    const out = await handleCommand('/clear', ctx)

    expect(repo.getThread('thread-1')!.cc_session_id).toBeNull()
    // The Discord thread and its history survive; only Claude's memory goes.
    expect(repo.getThread('thread-1')!.state).toBe('open')
    expect(out.handled && out.reply).toContain('fresh conversation')
  })

  test('says so when there is nothing to clear', async () => {
    const { ctx } = setup()
    const out = await handleCommand('/clear', ctx)
    expect(out.handled && out.reply).toContain('Nothing to clear')
  })
})

describe('/stop', () => {
  test('reports when a turn was actually cancelled', async () => {
    const { ctx } = setup({ running: true })
    const out = await handleCommand('/stop', ctx)
    expect(out.handled && out.reply).toContain('Stopping')
  })

  test('does not claim to stop something that is not running', async () => {
    const { ctx } = setup({ running: false })
    const out = await handleCommand('/stop', ctx)
    expect(out.handled && out.reply).toContain('Nothing is running')
  })
})

describe('/permissions', () => {
  test('lists the modes when given no argument', async () => {
    const { ctx } = setup()
    const out = await handleCommand('/permissions', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('auto')
    expect(reply).toContain('acceptEdits')
  })

  test('a valid mode is persisted', async () => {
    const { ctx, repo } = setup()
    await handleCommand('/permissions acceptEdits', ctx)
    expect(repo.getThread('thread-1')!.permission_mode).toBe('acceptEdits')
  })

  test('an unknown mode changes nothing', async () => {
    const { ctx, repo } = setup()
    const out = await handleCommand('/permissions yolo', ctx)
    expect(out.handled && out.reply).toContain('Unknown mode')
    expect(repo.getThread('thread-1')!.permission_mode).toBeNull()
  })

  test('bypassPermissions cannot be set from chat', async () => {
    const { ctx, repo } = setup()
    // Granting it from a Discord message would remove the approval path the
    // permission buttons exist to provide.
    const out = await handleCommand('/permissions bypassPermissions', ctx)
    expect(out.handled && out.reply).toContain('Unknown mode')
    expect(repo.getThread('thread-1')!.permission_mode).toBeNull()
  })

  test('/permission is accepted as an alias', async () => {
    const { ctx } = setup()
    expect((await handleCommand('/permission', ctx)).handled).toBe(true)
  })
})

describe('/cost', () => {
  test('says so before any turn has completed', async () => {
    const { ctx } = setup()
    const out = await handleCommand('/cost', ctx)
    expect(out.handled && out.reply).toContain('No completed turns')
  })

  test('sums recorded usage across completed turns only', async () => {
    const { ctx, repo } = setup()
    const a = repo.enqueueTurn({ threadId: 'thread-1', inboundMessageId: 'm1', authorId: 'u', content: 'x' })!
    repo.recordTurnUsage(a.id, { costUsd: 0.02, inputTokens: 100, outputTokens: 50 })
    repo.finishTurn(a.id, ['s1'])

    // A failed turn is excluded: the user did not get an answer for it.
    const b = repo.enqueueTurn({ threadId: 'thread-1', inboundMessageId: 'm2', authorId: 'u', content: 'y' })!
    repo.recordTurnUsage(b.id, { costUsd: 99, inputTokens: 1, outputTokens: 1 })
    repo.failTurn(b.id, 'boom')

    const out = await handleCommand('/cost', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('$0.0200')
    expect(reply).toContain('150')
    // The $99 failed turn must not be counted: the user got no answer for it.
    expect(reply).toContain('**1** turn')
    expect(reply).not.toContain('99')
  })
})

describe('/threads', () => {
  test('lists open threads and marks the current one', async () => {
    const { ctx, repo } = setup()
    repo.createThread({
      thread_id: 'thread-9', channel_id: 'chan-1', root_message_id: null,
      guild_id: 'guild-1', cc_session_id: null, cwd: '/home/agent',
      title: null, state: 'open', model: null, permission_mode: null,
      header_message_id: null,
    })
    const out = await handleCommand('/threads', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('thread-1')
    expect(reply).toContain('thread-9')
    expect(reply).toContain('← here')
  })

  test('archived threads are not listed', async () => {
    const { ctx, repo } = setup()
    repo.archiveThread('thread-1')
    const out = await handleCommand('/threads', ctx)
    expect(out.handled && out.reply).toContain('No open threads')
  })
})

describe('/compact', () => {
  test('falls through, because Claude Code handles it natively', async () => {
    const { ctx } = setup()
    // The CLI intercepts /compact before the model. Handling it in the daemon
    // would replace a working implementation with a worse one.
    expect((await handleCommand('/compact', ctx)).handled).toBe(false)
  })

  test('is advertised in /help, marked as the one that costs tokens', async () => {
    const { ctx } = setup()
    const out = await handleCommand('/help', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('/compact')
    expect(reply).toContain('costs tokens')
  })
})

describe('compaction reporting', () => {
  test('a silent compaction becomes a readable answer, not an error', () => {
    // /compact succeeds with an EMPTY result string, which would otherwise
    // trip the "produced no reply" path and post ❌ for a command that worked.
    const text = describeCompaction({ preTokens: 15867, postTokens: 1922, durationMs: 12319 })
    expect(text).toContain('15,867')
    expect(text).toContain('1,922')
    expect(text).toContain('13,945')
    expect(text).toContain('12.3s')
  })

  test('reads sensibly when the post-compaction size is unknown', () => {
    const text = describeCompaction({ preTokens: 5000 })
    expect(text).toContain('5,000')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('undefined')
  })
})

describe('/model global', () => {
  test('sets the model new threads start on, without moving this thread', async () => {
    const { ctx, repo } = setup()
    const out = await handleCommand('/model global sonnet', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('sonnet')
    expect(repo.defaultModel()).toBe('sonnet')
    // The open thread keeps whatever it was opened with.
    expect(repo.getThread('thread-1')?.model).toBeNull()
  }, 30_000)

  test('a new thread inherits the default at the moment it is opened', async () => {
    const { repo } = setup()
    repo.setDefaultModel('sonnet')
    const thread = repo.createThread({
      thread_id: 'thread-2',
      channel_id: 'chan-1',
      root_message_id: null,
      guild_id: 'guild-1',
      cc_session_id: null,
      cwd: '/home/agent',
      title: null,
      state: 'open',
      model: repo.defaultModel(),
      permission_mode: null,
      header_message_id: null,
    })
    expect(thread.model).toBe('sonnet')
    // Changing the default afterwards must not move a live conversation.
    repo.setDefaultModel('haiku')
    expect(repo.getThread('thread-2')?.model).toBe('sonnet')
  })

  test('resetting returns new threads to the account default', async () => {
    const { ctx, repo } = setup()
    repo.setDefaultModel('sonnet')
    const out = await handleCommand('/model global default', ctx)
    expect(out.handled && out.reply).toContain('account default')
    expect(repo.defaultModel()).toBeNull()
  })

  test('/model reset falls back to the global default, not past it', async () => {
    const { ctx, repo } = setup()
    repo.setDefaultModel('sonnet')
    repo.setThreadModel('thread-1', 'haiku')
    await handleCommand('/model reset', ctx)
    expect(repo.getThread('thread-1')?.model).toBe('sonnet')
  })

  test('/model reports both the thread model and the default', async () => {
    const { ctx, repo } = setup()
    repo.setDefaultModel('sonnet')
    const out = await handleCommand('/model', ctx)
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('Model for this thread')
    expect(reply).toContain('New threads start on: **sonnet**')
  }, 30_000)
})

describe('/model outside a thread', () => {
  // The channel a thread is spawned from has no conversation of its own, so
  // there is no per-thread model there. Before this, `/model` in a channel
  // answered "no record of this thread yet" — which was both true and useless,
  // since it is the one place you would want to set what new threads open on.
  const inChannel = (ctx: ReturnType<typeof setup>['ctx']) => ({
    ...ctx,
    conversationId: 'chan-1',
  })

  test('setting a model in a channel sets what new threads start on', async () => {
    const { ctx, repo } = setup()
    const out = await handleCommand('/model sonnet', inChannel(ctx))
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('New threads will start on')
    expect(repo.defaultModel()).toBe('sonnet')
    // Answering must not conjure a thread row for a channel.
    expect(repo.getThread('chan-1')).toBeNull()
  }, 30_000)

  test('a bare /model in a channel reports the default instead of an error', async () => {
    const { ctx, repo } = setup()
    repo.setDefaultModel('sonnet')
    const out = await handleCommand('/model', inChannel(ctx))
    const reply = out.handled ? out.reply : ''
    expect(reply).toContain('New threads start on: **sonnet**')
    expect(reply).not.toContain('no conversation here yet')
  }, 30_000)

  test('commands that are genuinely thread-scoped still say so', async () => {
    const { ctx } = setup()
    const out = await handleCommand('/cwd', inChannel(ctx))
    expect(out.handled && out.reply).toContain('no conversation here yet')
  })
})

describe('empty final result', () => {
  const ctx = {} as Parameters<typeof consume>[1]
  const success = { type: 'result', subtype: 'success', result: '', session_id: 's' } as unknown as Parameters<typeof consume>[0]

  test('falls back to the last assistant text instead of "no reply"', () => {
    const assistant = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is the answer.' }, { type: 'tool_use', name: 'Bash' }] },
    } as unknown as Parameters<typeof consume>[0]
    const { assistantText } = consume(assistant, ctx)
    expect(assistantText).toBe('Here is the answer.')
    const out = consume(success, ctx, assistantText)
    expect(out.result).toMatchObject({ kind: 'reply', text: 'Here is the answer.' })
  })

  test('still errors when the model wrote nothing at all', () => {
    expect(consume(success, ctx).result).toMatchObject({ kind: 'error' })
  })
})
