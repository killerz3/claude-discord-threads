/**
 * Small helpers ported from the official plugin's server.ts. These are the
 * hardened bits — they exist because of specific failure modes, so the
 * comments explaining *why* matter more than the code.
 */

import { realpathSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import type { Attachment } from 'discord.js'
import { INBOX_DIR, MAX_ATTACHMENT_BYTES, MAX_CHUNK_LIMIT, STATE_DIR } from '../config'

/**
 * Discord rejects messages over 2000 characters outright, so long replies are
 * split. `newline` mode prefers paragraph then line then word boundaries,
 * which keeps code blocks and prose from being cut mid-token.
 */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      // Only honour a boundary in the back half, or a long unbroken run would
      // produce a stream of tiny messages.
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export function clampChunkLimit(configured: number | undefined): number {
  return Math.max(1, Math.min(configured ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
}

/**
 * Refuse to upload the channel's own state directory.
 *
 * Attachment paths are model-supplied. Claude can already read and paste file
 * contents, so this is not a general exfiltration boundary — but access.json
 * and .env are the one thing it has no legitimate reason to send, and the
 * token lives there. inbox/ is exempt: those files came from Discord already.
 */
export function assertSendable(f: string): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    // statSync will surface a real error; or STATE_DIR is absent, so there is
    // nothing to leak.
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function assertAttachable(paths: string[]): void {
  if (paths.length > 10) throw new Error('Discord allows max 10 attachments per message')
  for (const f of paths) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`,
      )
    }
  }
}

/**
 * Attachment names are uploader-controlled and get interpolated into
 * annotations and newline-joined tool results, where these characters would
 * let an attacker break out of the untrusted frame.
 */
export function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

export async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, ` +
        `max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
    )
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? att.id
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

/**
 * Discord thread names are capped at 100 characters. Collapse whitespace and
 * trim to something that reads as a title in the sidebar.
 */
export function threadName(raw: string, fallback = 'conversation'): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return fallback
  if (flat.length <= 90) return flat
  return flat.slice(0, 89).replace(/\s\S*$/, '') + '…'
}
