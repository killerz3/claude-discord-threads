/**
 * Permission prompts, relayed to Discord.
 *
 * A headless worker has no terminal to prompt in, so the SDK's `canUseTool`
 * callback is answered by a human tapping a button in the thread. The turn
 * blocks until they do, or until it times out and denies.
 *
 * Two properties the SDK contract demands (see docs/sdk-notes.md):
 *
 *   - **Idempotent per requestId.** After a reconnect the SDK redelivers
 *     control requests whose responses were lost, so the same request may
 *     arrive twice and must resolve to the same answer, not a second prompt.
 *   - **Never resolve null.** A null response fails closed with no message, so
 *     every path here returns an explicit allow or deny.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  type Message,
} from 'discord.js'
import { randomBytes } from 'crypto'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Database } from 'bun:sqlite'
import { permissionTimeoutMs } from '../config'
import { fetchSendable } from './threads'
import { noteSent } from './access'

type PermissionResult = Awaited<ReturnType<NonNullable<Options['canUseTool']>>>
type Allow = Extract<NonNullable<PermissionResult>, { behavior: 'allow' }>
type Deny = Extract<NonNullable<PermissionResult>, { behavior: 'deny' }>

/**
 * Reply grammar carried over from the official plugin: 5 lowercase letters,
 * 'l' excluded because it reads as '1'. Case-insensitive for phone autocorrect,
 * and strict about surrounding text so ordinary chat never looks like consent.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

function shortCode(): string {
  const bytes = randomBytes(5)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

type Pending = {
  code: string
  requestId: string
  conversationId: string
  toolName: string
  /** Applied when the operator chooses "Always allow". */
  suggestions: NonNullable<Allow['updatedPermissions']>
  resolve: (r: PermissionResult) => void
  settled: boolean
  message: Message | null
  timer: Timer
}

export class PermissionBroker {
  private byCode = new Map<string, Pending>()
  /** Deduplicates SDK redelivery: one answer per requestId, forever. */
  private byRequest = new Map<string, Promise<PermissionResult>>()

  constructor(
    private client: Client,
    private db: Database,
  ) {}

  /**
   * Build a `canUseTool` bound to one conversation, so the prompt lands in the
   * thread whose turn triggered it.
   */
  forConversation(conversationId: string, turnId: number): NonNullable<Options['canUseTool']> {
    return (toolName, input, options) => {
      const existing = this.byRequest.get(options.requestId)
      if (existing) return existing

      const promise = this.ask(conversationId, turnId, toolName, input, options)
      this.byRequest.set(options.requestId, promise)
      return promise
    }
  }

  private async ask(
    conversationId: string,
    turnId: number,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<NonNullable<Options['canUseTool']>>[2],
  ): Promise<PermissionResult> {
    const code = shortCode()
    const suggestions = options.suggestions ?? []

    this.db.run(
      `INSERT INTO permissions (request_id, turn_id, tool_name, input_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO NOTHING`,
      [options.requestId, turnId, toolName, JSON.stringify(input).slice(0, 4000), Date.now()],
    )

    const timeoutMs = permissionTimeoutMs()
    return new Promise<PermissionResult>(resolve => {
      const timer = setTimeout(() => {
        this.settle(code, {
          behavior: 'deny',
          message: `No answer on Discord within ${Math.round(timeoutMs / 1000)}s.`,
        })
      }, timeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()

      const pending: Pending = {
        code,
        requestId: options.requestId,
        conversationId,
        toolName,
        suggestions,
        resolve,
        settled: false,
        message: null,
        timer,
      }
      this.byCode.set(code, pending)

      // Aborting the turn (shutdown, interrupt) must still produce an answer.
      options.signal.addEventListener('abort', () => {
        this.settle(code, { behavior: 'deny', message: 'The turn was interrupted.' })
      })

      void this.post(pending, options).catch(err => {
        process.stderr.write(`discord-threads: permission prompt failed to post: ${err}\n`)
        // If we cannot ask, we must not silently allow.
        this.settle(code, {
          behavior: 'deny',
          message: 'Could not reach Discord to ask for approval.',
        })
      })
    })
  }

  private async post(
    pending: Pending,
    options: Parameters<NonNullable<Options['canUseTool']>>[2],
  ): Promise<void> {
    const ch = await fetchSendable(this.client, pending.conversationId)

    // Prefer the bridge's own rendered sentence over reconstructing one.
    const headline = options.title ?? `Claude wants to use ${pending.toolName}`
    const detail = options.description ? `\n${options.description}` : ''
    const why = options.decisionReason ? `\n_${options.decisionReason}_` : ''
    const label = options.displayName ?? pending.toolName

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:allow:${pending.code}`)
        .setLabel('Allow')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm:deny:${pending.code}`)
        .setLabel('Deny')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    )
    // Only offer "always" when the SDK gave us rules that would actually stop
    // the prompt recurring.
    if (pending.suggestions.length > 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`perm:always:${pending.code}`)
          .setLabel('Always allow')
          .setStyle(ButtonStyle.Secondary),
      )
    }

    const sent = await ch.send({
      content:
        `🔐 **${headline}**${detail}${why}\n` +
        `\`${label}\` · reply \`y ${pending.code}\` or \`n ${pending.code}\` if the buttons don't work`,
      components: [row],
    })
    noteSent(sent.id)
    pending.message = sent
  }

  /** Resolve a prompt exactly once and retire its buttons. */
  private settle(code: string, result: PermissionResult): void {
    const pending = this.byCode.get(code)
    if (!pending || pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    this.byCode.delete(code)

    const decision = result?.behavior ?? 'deny'
    this.db.run('UPDATE permissions SET decision = ? WHERE request_id = ?', [
      decision,
      pending.requestId,
    ])
    pending.resolve(result)

    const outcome =
      decision === 'allow' ? '✅ Allowed' : `❌ Denied${denyReason(result)}`
    // Strip the buttons so the same request cannot be answered twice and the
    // thread records what was chosen.
    void pending.message
      ?.edit({ content: `${pending.message.content}\n\n${outcome}`, components: [] })
      .catch(() => {})
  }

  /** Wire up Discord button clicks. Called once at daemon start. */
  attach(isAllowedUser: (userId: string) => boolean): void {
    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isButton()) return
      const m = /^perm:(allow|deny|always):([a-km-z]{5})$/.exec(interaction.customId)
      if (!m) return

      // Same authority check as the inbound gate: a button in a channel other
      // people can see must not let them approve anything.
      if (!isAllowedUser(interaction.user.id)) {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
        return
      }

      const [, action, code] = m
      const pending = this.byCode.get(code!)
      if (!pending) {
        await interaction
          .reply({ content: 'That request is no longer pending.', ephemeral: true })
          .catch(() => {})
        return
      }
      await interaction.deferUpdate().catch(() => {})
      this.settle(code!, this.resultFor(action!, pending))
    })
  }

  /**
   * Answer via the `y <code>` / `n <code>` text grammar, for clients where the
   * buttons are awkward. Returns true if the message was consumed as an answer
   * and should not be treated as chat.
   */
  handleTextReply(content: string): boolean {
    const m = PERMISSION_REPLY_RE.exec(content)
    if (!m) return false
    const code = m[2]!.toLowerCase()
    const pending = this.byCode.get(code)
    if (!pending) return false
    const allow = m[1]!.toLowerCase().startsWith('y')
    this.settle(code, this.resultFor(allow ? 'allow' : 'deny', pending))
    return true
  }

  private resultFor(action: string, pending: Pending): PermissionResult {
    if (action === 'always') {
      return { behavior: 'allow', updatedPermissions: pending.suggestions } satisfies Allow
    }
    if (action === 'allow') return { behavior: 'allow' } satisfies Allow
    return { behavior: 'deny', message: 'Denied from Discord.' } satisfies Deny
  }

  /** Deny everything still outstanding, e.g. during shutdown. */
  drain(): void {
    for (const code of [...this.byCode.keys()]) {
      this.settle(code, { behavior: 'deny', message: 'The daemon is shutting down.' })
    }
  }
}

function denyReason(result: PermissionResult): string {
  if (result && result.behavior === 'deny' && result.message) return ` — ${result.message}`
  return ''
}
