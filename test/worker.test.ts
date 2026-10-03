import { describe, expect, mock, test } from 'bun:test'

// Each call to query() plays the next script: the messages the CLI would stream.
const scripts: unknown[][] = []
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
    (async function* () {
      const input = prompt[Symbol.asyncIterator]()
      await input.next()
      for (const message of scripts.shift() ?? []) yield message
    })(),
}))

const { makeClaudeResponder } = await import('../src/engine/worker')

const tasks = (n: number) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: Array.from({ length: n }, (_, i) => ({ task_id: `t${i}`, task_type: 'local_bash', description: 'tests' })),
})
const result = (text: string) => ({ type: 'result', subtype: 'success', session_id: 's1', result: text })

async function run(lateText: string): Promise<{ reply: string; late: string[] }> {
  scripts.push([tasks(1), result('Answer'), tasks(0), result(lateText)])
  const late: string[] = []
  const ctx = {
    turn: { content: 'hi' },
    conversationId: `c-${lateText}`,
    message: null,
    sessionId: null,
    cwd: '.',
    onLateReply: async (text: string) => void late.push(text),
  }
  const reply = await makeClaudeResponder()(ctx as never)
  await new Promise(r => setTimeout(r, 10))
  return { reply: reply.kind === 'reply' ? reply.text : reply.kind, late }
}

describe('late wake-ups after background work', () => {
  test('a real late answer is posted', async () => {
    expect(await run('Tests passed.')).toEqual({ reply: 'Answer', late: ['Tests passed.'] })
  })

  test('NO_REPLY is not posted', async () => {
    expect(await run('NO_REPLY')).toEqual({ reply: 'Answer', late: [] })
  })
})

describe('extractAttachments', () => {
  const { extractAttachments } = require('../src/engine/worker')
  const img = `${require('os').tmpdir()}/attach-fixture.png`
  require('fs').writeFileSync(img, 'x')

  test('ATTACH lines become files and leave the text', () => {
    const r = extractAttachments(`Here it is.\nATTACH: ${img}\nDone.`)
    expect(r.files).toEqual([img])
    expect(r.text).toBe('Here it is.\nDone.')
  })

  test('a missing file is reported, not fatal', () => {
    const r = extractAttachments('Look:\nATTACH: /nope/missing.png')
    expect(r.files).toEqual([])
    expect(r.text).toContain('could not attach /nope/missing.png')
  })

  test('attachment-only reply still has text', () => {
    expect(extractAttachments(`ATTACH: ${img}`).text).toBe('attach-fixture.png')
  })
})
