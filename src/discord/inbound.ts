/**
 * Turning a Discord message into the text a worker sees.
 *
 * Attachments are downloaded eagerly and their local paths handed to the model.
 * The official plugin listed them and let the model fetch them with a tool;
 * this daemon gives workers no Discord tools at all, so eager download is the
 * only way an image or a log file reaches them.
 */

import type { Message } from 'discord.js'
import { downloadAttachment, safeAttName } from './util'
import { log, describeError } from '../log'

/** Discord's own per-message limit; also a bound on work per turn. */
const MAX_ATTACHMENTS = 10

export async function composeTurnContent(msg: Message): Promise<string> {
  const text = msg.content.trim()
  if (msg.attachments.size === 0) return text

  const attachments = [...msg.attachments.values()].slice(0, MAX_ATTACHMENTS)
  const lines: string[] = []

  for (const att of attachments) {
    // safeAttName strips the delimiters that would otherwise let an uploader
    // forge extra lines in this list.
    const name = safeAttName(att)
    try {
      const path = await downloadAttachment(att)
      const kb = (att.size / 1024).toFixed(0)
      lines.push(`- ${name} (${att.contentType ?? 'unknown'}, ${kb}KB): ${path}`)
    } catch (err) {
      log.warn('attachment download failed', { name, error: describeError(err) })
      lines.push(`- ${name}: could not be downloaded (${describeError(err)})`)
    }
  }

  if (msg.attachments.size > MAX_ATTACHMENTS) {
    lines.push(`- (${msg.attachments.size - MAX_ATTACHMENTS} more not downloaded)`)
  }

  return [
    text || '(no message text)',
    '',
    'Files attached to this Discord message, already saved locally — read them if relevant:',
    ...lines,
  ].join('\n')
}
