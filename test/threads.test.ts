/**
 * The per-thread model banner.
 *
 * The property that matters is that a thread has exactly one banner: it is
 * posted once, edited in place afterwards, and never duplicated by a later
 * `/model`. A banner Discord has lost is the one case where posting again is
 * correct, and only where the caller asked for creation.
 */

import { test, expect, describe } from 'bun:test'
import type { Client } from 'discord.js'
import { openDb } from '../src/store/db'
import { Repo } from '../src/store/repo'
import { modelHeaderText, syncModelHeader } from '../src/discord/threads'

function setup(opts: { missingHeader?: boolean } = {}) {
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
    model: 'sonnet',
    permission_mode: null,
    header_message_id: null,
  })

  const sent: string[] = []
  const edits: string[] = []
  let nextId = 0
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        isSendable: () => true,
        send: async (content: string) => {
          sent.push(content)
          return { id: `header-${nextId++}` }
        },
        messages: {
          fetch: async (id: string) => {
            if (opts.missingHeader) throw new Error('Unknown Message')
            return { id, edit: async (content: string) => void edits.push(content) }
          },
        },
      }),
    },
  } as unknown as Client
  return { repo, client, sent, edits }
}

describe('model header', () => {
  test('names the model, and says so plainly when there is no override', () => {
    expect(modelHeaderText('sonnet')).toContain('sonnet')
    expect(modelHeaderText(null)).toContain('account default')
  })

  test('is posted once and then edited in place', async () => {
    const { repo, client, sent, edits } = setup()
    await syncModelHeader(client, repo, 'thread-1', { create: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('sonnet')
    expect(repo.getThread('thread-1')?.header_message_id).toBe('header-0')

    repo.setThreadModel('thread-1', 'haiku')
    await syncModelHeader(client, repo, 'thread-1')
    expect(sent).toHaveLength(1)
    expect(edits).toEqual([modelHeaderText('haiku')])
  })

  test('does not post a banner mid-conversation when none exists', async () => {
    const { repo, client, sent } = setup()
    await syncModelHeader(client, repo, 'thread-1')
    expect(sent).toHaveLength(0)
  })

  test('forgets a banner Discord has lost rather than editing forever', async () => {
    const { repo, client, sent } = setup({ missingHeader: true })
    repo.setThreadHeaderMessage('thread-1', 'header-gone')
    await syncModelHeader(client, repo, 'thread-1')
    expect(sent).toHaveLength(0)
    expect(repo.getThread('thread-1')?.header_message_id).toBeNull()
  })
})
