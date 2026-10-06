/**
 * Turning a Discord message into the text (and images) a worker sees.
 *
 * Attachments are downloaded eagerly and their local paths handed to the
 * model as text. The official plugin listed them and let the model fetch
 * them with a tool; this daemon gives workers no Discord tools at all, so
 * eager download is the only way an image or a log file reaches them.
 *
 * Small, common-format images are additionally read back and handed to the
 * SDK as inline image content blocks (see `engine/worker.ts`'s
 * `buildInitialContent`) — the same thing Claude Code's own CLI does with a
 * pasted image. Without that, a bare image attachment with no accompanying
 * text produced a thin prompt (a file path and nothing else) that the model
 * could satisfy without ever reading the file, which looked like the thread
 * had lost its earlier context.
 */

import type { Message } from 'discord.js'
import { downloadAttachment, safeAttName } from './util'
import { log, describeError } from '../log'
import type { InlineImage } from '../store/db'

/** Discord's own per-message limit; also a bound on work per turn. */
const MAX_ATTACHMENTS = 10

const INLINE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

/** Anthropic's own per-image ceiling for inline base64; larger stays path-only. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024

export type TurnContent = {
  text: string
  images: InlineImage[]
}

/**
 * @param overrideText Used by `/model <name> <message>`: the prompt is the
 * text after the model name, not the raw message content, but attachments on
 * that same message still belong to the turn.
 */
export async function composeTurnContent(msg: Message, overrideText?: string): Promise<TurnContent> {
  const text = (overrideText ?? msg.content).trim()
  if (msg.attachments.size === 0) return { text, images: [] }

  const attachments = [...msg.attachments.values()].slice(0, MAX_ATTACHMENTS)
  const lines: string[] = []
  const images: InlineImage[] = []

  for (const att of attachments) {
    // safeAttName strips the delimiters that would otherwise let an uploader
    // forge extra lines in this list.
    const name = safeAttName(att)
    try {
      const path = await downloadAttachment(att)
      const kb = (att.size / 1024).toFixed(0)
      lines.push(`- ${name} (${att.contentType ?? 'unknown'}, ${kb}KB): ${path}`)
      const mediaType = att.contentType?.split(';')[0]
      if (
        mediaType &&
        INLINE_IMAGE_MEDIA_TYPES.has(mediaType) &&
        att.size <= MAX_INLINE_IMAGE_BYTES
      ) {
        images.push({ path, mediaType: mediaType as InlineImage['mediaType'] })
      }
    } catch (err) {
      log.warn('attachment download failed', { name, error: describeError(err) })
      lines.push(`- ${name}: could not be downloaded (${describeError(err)})`)
    }
  }

  if (msg.attachments.size > MAX_ATTACHMENTS) {
    lines.push(`- (${msg.attachments.size - MAX_ATTACHMENTS} more not downloaded)`)
  }

  return {
    text: [
      text || '(no message text)',
      '',
      'Files attached to this Discord message, already saved locally — read them if relevant:',
      ...lines,
    ].join('\n'),
    images,
  }
}
