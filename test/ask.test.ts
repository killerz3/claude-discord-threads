import { expect, test } from 'bun:test'
import { quoteSource } from '../src/discord/ask'

test('quotes the tapped message and its files', () => {
  const msg = {
    content: 'Draft: rank-a-list\nline two',
    attachments: new Map([['1', { name: 'v.mp4', url: 'https://cdn/v.mp4' }]]),
  } as any
  expect(quoteSource(msg)).toBe(
    'Feedback via the Tell Claude button on this message:\n> Draft: rank-a-list\n> line two\n> v.mp4: https://cdn/v.mp4',
  )
})
