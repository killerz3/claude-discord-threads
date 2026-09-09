/**
 * The permission relay's contract with the Agent SDK.
 *
 * Two rules from docs/sdk-notes.md drive these tests, and both are safety
 * properties rather than features:
 *
 *   - resolving `null` fails closed silently, so every path must return an
 *     explicit allow or deny
 *   - the SDK redelivers control requests after a reconnect, so the same
 *     requestId must resolve once and identically
 */

// Keep the timeout tests fast. config reads this per call, so import order
// between test files does not matter.
process.env.DISCORD_PERMISSION_TIMEOUT_MS = '150'

import { test, expect, describe } from 'bun:test'
import type { Client } from 'discord.js'
import { openDb } from '../src/store/db'
import { PermissionBroker, PERMISSION_REPLY_RE } from '../src/discord/permissions'

/** Minimal stand-ins for the Discord objects the broker touches. */
function fakeClient(opts: { failSend?: boolean } = {}) {
  const posted: string[] = []
  const edits: string[] = []
  const channel = {
    send: async ({ content }: { content: string }) => {
      if (opts.failSend) throw new Error('discord unreachable')
      posted.push(content)
      return {
        id: `msg-${posted.length}`,
        content,
        edit: async (body: { content: string }) => {
          edits.push(body.content)
        },
        delete: async () => {},
      }
    },
    isTextBased: () => true,
    isSendable: () => true,
  }
  const handlers: Array<(i: unknown) => unknown> = []
  const client = {
    channels: { fetch: async () => channel },
    on: (event: string, fn: (i: unknown) => unknown) => {
      if (event === 'interactionCreate') handlers.push(fn)
    },
  }
  return { client: client as unknown as Client, posted, edits, handlers }
}

function askOptions(requestId: string, extra: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tu-1',
    requestId,
    ...extra,
  } as unknown as Parameters<NonNullable<ReturnType<PermissionBroker['forConversation']>>>[2]
}

function setup(opts: { failSend?: boolean } = {}) {
  const fake = fakeClient(opts)
  const db = openDb(':memory:')
  const broker = new PermissionBroker(fake.client, db)
  const canUseTool = broker.forConversation('thread-1', 1)
  return { ...fake, db, broker, canUseTool }
}

/** Click a button by driving the registered interactionCreate handler. */
async function click(
  handlers: Array<(i: unknown) => unknown>,
  customId: string,
  userId = 'owner',
) {
  for (const h of handlers) {
    await h({
      isButton: () => true,
      customId,
      user: { id: userId },
      deferUpdate: async () => {},
      reply: async () => {},
    })
  }
}

describe('answering', () => {
  test('a button click allows the tool', async () => {
    const { posted, handlers, broker, canUseTool } = setup()
    broker.attach(() => true)

    const pending = canUseTool('Bash', { command: 'ls' }, askOptions('req-1'))
    await Bun.sleep(10)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!
    await click(handlers, `perm:allow:${code}`)

    expect(await pending).toEqual({ behavior: 'allow' })
  })

  test('a denial carries a message, as the SDK requires', async () => {
    const { posted, handlers, broker, canUseTool } = setup()
    broker.attach(() => true)

    const pending = canUseTool('Bash', { command: 'rm -rf /' }, askOptions('req-1'))
    await Bun.sleep(10)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!
    await click(handlers, `perm:deny:${code}`)

    const result = await pending
    expect(result?.behavior).toBe('deny')
    expect(result && 'message' in result ? result.message : '').toBeTruthy()
  })

  test('"Always allow" returns the SDK suggestions as permission updates', async () => {
    const { posted, handlers, broker, canUseTool } = setup()
    broker.attach(() => true)
    const suggestions = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    ]

    const pending = canUseTool('Bash', {}, askOptions('req-1', { suggestions }))
    await Bun.sleep(10)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!
    await click(handlers, `perm:always:${code}`)

    const result = await pending
    expect(result).toEqual({ behavior: 'allow', updatedPermissions: suggestions as never })
  })

  test('the button is offered only when suggestions exist', async () => {
    const { posted, canUseTool } = setup()
    void canUseTool('Bash', {}, askOptions('req-1'))
    await Bun.sleep(10)
    // Nothing to persist means "Always allow" would be a lie.
    expect(posted[0]).not.toContain('Always allow')
  })

  test('the text grammar answers a prompt', async () => {
    const { posted, broker, canUseTool } = setup()
    const pending = canUseTool('Bash', {}, askOptions('req-1'))
    await Bun.sleep(10)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!

    expect(broker.handleTextReply(`y ${code}`)).toBe(true)
    expect((await pending)?.behavior).toBe('allow')
  })

  test('ordinary chat is not mistaken for consent', () => {
    const { broker } = setup()
    for (const text of ['yes', 'no', 'yes please do that', 'y', 'sure y abcde ok']) {
      expect(broker.handleTextReply(text)).toBe(false)
    }
    // The grammar itself only matches the strict form.
    expect(PERMISSION_REPLY_RE.test('y abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('yes abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('yeah abcde')).toBe(false)
  })
})

describe('fail-closed', () => {
  test('no answer within the timeout denies rather than hanging', async () => {
    const { canUseTool } = setup()
    const result = await canUseTool('Bash', {}, askOptions('req-1'))
    expect(result?.behavior).toBe('deny')
  })

  test('an unreachable Discord denies rather than allowing', async () => {
    const { canUseTool } = setup({ failSend: true })
    const result = await canUseTool('Bash', {}, askOptions('req-1'))
    // If we cannot ask, we must not assume yes.
    expect(result?.behavior).toBe('deny')
  })

  test('an aborted turn resolves instead of leaving the SDK waiting', async () => {
    const { canUseTool } = setup()
    const controller = new AbortController()
    const pending = canUseTool('Bash', {}, askOptions('req-1', { signal: controller.signal }))
    controller.abort()
    expect((await pending)?.behavior).toBe('deny')
  })

  test('a result is never null on any path', async () => {
    const { canUseTool } = setup({ failSend: true })
    const result = await canUseTool('Bash', {}, askOptions('req-1'))
    // A null response fails closed silently, which is the one outcome that
    // leaves no trace for the operator.
    expect(result).not.toBeNull()
  })
})

describe('idempotency', () => {
  test('a redelivered requestId reuses the first prompt and answer', async () => {
    const { posted, handlers, broker, canUseTool } = setup()
    broker.attach(() => true)

    const first = canUseTool('Bash', {}, askOptions('req-1'))
    await Bun.sleep(10)
    // The SDK redelivers after a reconnect; this must not ask the user twice.
    const second = canUseTool('Bash', {}, askOptions('req-1'))

    expect(posted).toHaveLength(1)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!
    await click(handlers, `perm:allow:${code}`)

    expect(await first).toEqual({ behavior: 'allow' })
    expect(await second).toEqual({ behavior: 'allow' })
  })

  test('a second click cannot change a settled decision', async () => {
    const { posted, handlers, broker, canUseTool } = setup()
    broker.attach(() => true)

    const pending = canUseTool('Bash', {}, askOptions('req-1'))
    await Bun.sleep(10)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!
    await click(handlers, `perm:allow:${code}`)
    await click(handlers, `perm:deny:${code}`)

    expect((await pending)?.behavior).toBe('allow')
  })
})

describe('authority', () => {
  test('a non-allowlisted user cannot approve', async () => {
    const { posted, handlers, broker, canUseTool } = setup()
    broker.attach(userId => userId === 'owner')

    const pending = canUseTool('Bash', {}, askOptions('req-1'))
    await Bun.sleep(10)
    const code = /`y (\w{5})`/.exec(posted[0]!)![1]!
    await click(handlers, `perm:allow:${code}`, 'stranger')

    // The click is ignored, so the prompt times out and denies.
    expect((await pending)?.behavior).toBe('deny')
  })
})
