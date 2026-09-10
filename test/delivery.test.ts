/**
 * The delivery guarantee, tested against the failure modes that motivated it.
 *
 * The bug this project replaces is a silently unanswered Discord message, so
 * these tests care about exactly one question: after any interleaving of
 * crashes and redeliveries, how many messages did the user actually receive?
 */

import { test, expect, describe } from 'bun:test'
import type { SendableChannels } from 'discord.js'
import { openDb } from '../src/store/db'
import { Repo } from '../src/store/repo'
import { Delivery, type Responder, type TurnContext } from '../src/engine/delivery'
import type { Signals } from '../src/discord/signals'
import { isNewerSnowflake } from '../src/store/repo'

/** Records every send so a test can assert on what the user would have seen. */
function fakeChannel() {
  const sent: string[] = []
  let nextId = 1
  const ch = {
    send: async ({ content }: { content: string }) => {
      sent.push(content)
      return { id: `sent-${nextId++}` }
    },
  }
  return { sent, ch: ch as unknown as SendableChannels }
}

/** Signals are cosmetic; the delivery path must not depend on them. */
const noopSignals = {
  working: async () => {},
  settled: async () => {},
  seen: async () => {},
  react: async () => {},
  unreact: async () => {},
  startTyping: () => {},
  stopTyping: () => {},
  drain: async () => {},
} as unknown as Signals

function harness(responder: Responder) {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  const { sent, ch } = fakeChannel()
  const delivery = new Delivery({
    repo,
    signals: noopSignals,
    responder,
    resolveTarget: async () => ch,
  })
  repo.createThread({
    thread_id: 'thread-1',
    channel_id: 'chan-1',
    root_message_id: 'msg-1',
    guild_id: 'guild-1',
    cc_session_id: null,
    cwd: '/tmp',
    title: null,
    state: 'open',
    model: null,
    permission_mode: null,
    header_message_id: null,
  })
  return { db, repo, delivery, sent }
}

function ctxFor(repo: Repo, turnId: number): TurnContext {
  const turn = repo.getTurn(turnId)!
  return {
    turn,
    conversationId: turn.thread_id,
    message: null,
    sessionId: null,
    cwd: '/tmp',
  }
}

const reply = (text: string): Responder => async () => ({ kind: 'reply', text })

describe('happy path', () => {
  test('an accepted message is answered exactly once and recorded as done', async () => {
    const { repo, delivery, sent } = harness(reply('hello'))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    await delivery.submit(ctxFor(repo, turn.id))

    expect(sent).toEqual(['hello'])
    const after = repo.getTurn(turn.id)!
    expect(after.state).toBe('done')
    expect(repo.replyIdsOf(after)).toHaveLength(1)
  })

  test('the session id from the first turn is persisted for resumption', async () => {
    const { repo, delivery } = harness(async () => ({
      kind: 'reply',
      text: 'ok',
      sessionId: 'sess-abc',
    }))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    await delivery.submit(ctxFor(repo, turn.id))

    expect(repo.getThread('thread-1')!.cc_session_id).toBe('sess-abc')
  })
})

describe('idempotency', () => {
  test('a redelivered message does not create a second turn', () => {
    const { repo } = harness(reply('x'))
    const first = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })
    const second = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })

    expect(first).not.toBeNull()
    // Null is the signal to the daemon that this message is already owed or
    // already answered, so it must not be queued again.
    expect(second).toBeNull()
  })
})

describe('crash recovery', () => {
  test('a turn interrupted before sending is replayed and delivered once', async () => {
    const { repo, delivery, sent } = harness(reply('recovered answer'))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!
    // Simulate kill -9 while the model was running: the row is non-terminal
    // and no reply ids were ever recorded.
    repo.setTurnState(turn.id, 'running')

    const stats = await delivery.recover(async t => ctxFor(repo, t.id))
    await delivery.drain()

    expect(stats.replayed).toBe(1)
    expect(stats.reconciled).toBe(0)
    expect(sent).toEqual(['recovered answer'])
    expect(repo.getTurn(turn.id)!.state).toBe('done')
  })

  test('a turn that already reached Discord is reconciled, never re-sent', async () => {
    const { repo, delivery, sent } = harness(reply('SHOULD NOT BE SENT AGAIN'))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!
    // The dangerous window: we sent, recorded the ids, then died before the
    // state flip. Re-running the model here would double-post to the user.
    repo.setTurnState(turn.id, 'delivering')
    repo.finishTurn(turn.id, ['already-sent-1'])
    repo.setTurnState(turn.id, 'delivering')

    const stats = await delivery.recover(async t => ctxFor(repo, t.id))
    await delivery.drain()

    expect(stats.reconciled).toBe(1)
    expect(stats.replayed).toBe(0)
    expect(sent).toEqual([])
    expect(repo.getTurn(turn.id)!.state).toBe('done')
  })

  test('a turn whose thread is gone fails loudly instead of vanishing', async () => {
    const { repo, delivery } = harness(reply('x'))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    const stats = await delivery.recover(async () => null)

    expect(stats.dropped).toBe(1)
    const after = repo.getTurn(turn.id)!
    expect(after.state).toBe('failed')
    expect(after.error).toContain('no longer reachable')
  })
})

describe('failure handling', () => {
  test('a model error still produces a visible answer and a terminal state', async () => {
    const { repo, delivery, sent } = harness(async () => ({
      kind: 'error',
      message: 'the model errored mid-turn',
    }))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    await delivery.submit(ctxFor(repo, turn.id))

    // The user must never be left with silence, even on failure.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('the model errored mid-turn')
    expect(repo.getTurn(turn.id)!.state).toBe('failed')
  })

  test('a thrown responder is caught and reported rather than losing the turn', async () => {
    const { repo, delivery, sent } = harness(async () => {
      throw new Error('worker exploded')
    })
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    await delivery.submit(ctxFor(repo, turn.id))

    expect(sent[0]).toContain('worker exploded')
    expect(repo.getTurn(turn.id)!.state).toBe('failed')
  })

  test('a rate limit requeues the turn instead of failing it', async () => {
    const { repo, delivery, sent } = harness(async () => ({
      kind: 'retry',
      afterMs: 60_000,
      reason: 'rate limited',
    }))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    await delivery.submit(ctxFor(repo, turn.id))

    const after = repo.getTurn(turn.id)!
    // Still owed: it must survive to be retried, not be marked failed.
    expect(after.state).toBe('queued')
    expect(after.attempts).toBe(1)
    expect(sent[0]).toContain('Rate limited')
  })
})

describe('ordering', () => {
  test('turns in one conversation are answered in order', async () => {
    const order: string[] = []
    const { repo, delivery } = harness(async ctx => {
      order.push(`start:${ctx.turn.content}`)
      await new Promise(r => setTimeout(r, ctx.turn.content === 'first' ? 30 : 0))
      order.push(`end:${ctx.turn.content}`)
      return { kind: 'reply', text: ctx.turn.content }
    })

    const a = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'u',
      content: 'first',
    })!
    const b = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-2',
      authorId: 'u',
      content: 'second',
    })!

    await Promise.all([delivery.submit(ctxFor(repo, a.id)), delivery.submit(ctxFor(repo, b.id))])

    // The slow first turn must not be overtaken by the fast second one.
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
  })
})

describe('watermarks', () => {
  test('snowflake comparison orders by length then lexically', () => {
    expect(isNewerSnowflake('1000', '999')).toBe(true)
    expect(isNewerSnowflake('1546748256178933822', '1546748256178933821')).toBe(true)
    expect(isNewerSnowflake('1546748256178933821', '1546748256178933822')).toBe(false)
  })

  test('a watermark never moves backwards', () => {
    const { repo } = harness(reply('x'))
    repo.setWatermark('chan-1', '1546748256178933822')
    // Out-of-order gateway delivery must not re-open handled messages.
    repo.setWatermark('chan-1', '1546748256178933800')
    expect(repo.getWatermark('chan-1')).toBe('1546748256178933822')
  })
})

describe('restart', () => {
  /** A second Delivery over the same ledger — i.e. the next boot. */
  function reboot(repo: Repo, responder: Responder) {
    const { sent, ch } = fakeChannel()
    const delivery = new Delivery({
      repo,
      signals: noopSignals,
      responder,
      resolveTarget: async () => ch,
    })
    return { delivery, sent }
  }

  test('a turn killed by an operator restart is owed, not failed', async () => {
    // systemd sends SIGTERM to the whole cgroup, so the worker's Claude Code
    // child dies and the SDK throws. That is indistinguishable from a crash at
    // the catch site, and marking it `failed` is what lost a real reply.
    let live!: Delivery
    const { repo, delivery, sent } = harness(async () => {
      live.beginShutdown()
      throw new Error('Claude Code process exited with code 143')
    })
    live = delivery
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!

    await delivery.submit(ctxFor(repo, turn.id))

    const after = repo.getTurn(turn.id)!
    expect(after.state).toBe('queued')
    expect(after.error).toContain('interrupted by restart')
    // No ❌ for something the operator did on purpose.
    expect(sent).toEqual([])

    const next = reboot(repo, reply('the answer, a restart late'))
    const stats = await next.delivery.recover(async t => ctxFor(repo, t.id))
    await next.delivery.drain()

    expect(stats.replayed).toBe(1)
    expect(next.sent).toEqual(['the answer, a restart late'])
    expect(repo.getTurn(turn.id)!.state).toBe('done')
  })

  test('a turn the user stopped is not resurrected by a restart', async () => {
    let live!: Delivery
    const abort = new AbortController()
    const { repo, delivery } = harness(async () => {
      live.beginShutdown()
      return { kind: 'error', message: 'Stopped.' }
    })
    live = delivery
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!
    abort.abort()

    await delivery.submit({ ...ctxFor(repo, turn.id), abort })

    expect(repo.getTurn(turn.id)!.state).toBe('failed')
  })

  test('a turn that keeps outliving restarts is eventually dropped', async () => {
    const { repo, delivery } = harness(reply('never gets here'))
    const turn = repo.enqueueTurn({
      threadId: 'thread-1',
      inboundMessageId: 'msg-1',
      authorId: 'user-1',
      content: 'hi',
    })!
    // Three restarts have already replayed this one; a fourth is more likely
    // to be the cause of the crash than a victim of it.
    for (let i = 0; i < 3; i++) repo.requeueTurn(turn.id, 'interrupted by restart: boom')

    const stats = await delivery.recover(async t => ctxFor(repo, t.id))

    expect(stats.replayed).toBe(0)
    expect(stats.dropped).toBe(1)
    expect(repo.getTurn(turn.id)!.error).toContain('gave up after')
  })
})
