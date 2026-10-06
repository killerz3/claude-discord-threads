/**
 * Turning a turn's stored content into what the SDK's first message carries.
 *
 * The bug this covers: an image attached with no text produced a prompt that
 * was only ever a file path, which the model could satisfy without reading —
 * from the user's side that looked exactly like the thread losing context.
 * `buildInitialContent` is what now hands the image to the model directly,
 * so these tests exercise it end to end against real files on disk rather
 * than mocking `fs`.
 */

import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildInitialContent } from '../src/engine/worker'

// A 1x1 transparent PNG — just needs to be valid bytes, never decoded here.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('buildInitialContent', () => {
  test('plain text with no images stays a bare string', () => {
    expect(buildInitialContent('fix the bug', null)).toBe('fix the bug')
  })

  test('an image attachment becomes a text block plus an image block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-threads-test-'))
    const path = join(dir, 'a.png')
    writeFileSync(path, PNG_BYTES)
    try {
      const imagePaths = JSON.stringify([{ path, mediaType: 'image/png' }])
      const content = buildInitialContent('check this screenshot', imagePaths)
      expect(Array.isArray(content)).toBe(true)
      const blocks = content as unknown as Array<Record<string, unknown>>
      expect(blocks[0]).toEqual({ type: 'text', text: 'check this screenshot' })
      expect(blocks[1]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES.toString('base64') },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing file is skipped rather than failing the whole turn', () => {
    const imagePaths = JSON.stringify([{ path: '/nonexistent/does-not-exist.png', mediaType: 'image/png' }])
    const content = buildInitialContent('look at this', imagePaths)
    // The text block survives; the unreadable image just never gets added.
    expect(content).toEqual([{ type: 'text', text: 'look at this' }])
  })

  test('malformed stored JSON falls back to the plain text', () => {
    expect(buildInitialContent('hi', 'not json')).toBe('hi')
  })

  test('an empty image list falls back to the plain text', () => {
    expect(buildInitialContent('hi', '[]')).toBe('hi')
  })
})
