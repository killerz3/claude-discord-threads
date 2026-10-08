/**
 * The "Tell Claude" button.
 *
 * Any message the bot posts with a button whose custom_id is `claude:ask`
 * (a draft, a report, a video) gets a one-tap way to send feedback: the
 * button opens a text box, and the note becomes a turn in a thread on that
 * message, with the message quoted so the model knows what "this" is.
 */

import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Interaction,
  type Message,
} from 'discord.js'
import { log, describeError } from '../log'

export const ASK_BUTTON_ID = 'claude:ask'
const MODAL_PREFIX = 'claude:ask-modal:'

export type AskDeps = {
  isAllowedUser: (userId: string) => boolean
  /** Open (or reuse) the thread on `source` and queue `content` as a turn. */
  startTurn: (source: Message, note: string, content: string, userId: string) => Promise<void>
}

/** The message text plus its files, quoted, so the model sees what was tapped. */
export function quoteSource(source: Message): string {
  const files = [...source.attachments.values()].map(a => `${a.name}: ${a.url}`)
  const body = [source.content.trim() || '(no text)', ...files].join('\n')
  return `Feedback via the Tell Claude button on this message:\n${body.replace(/^/gm, '> ')}`
}

export function attachAskHandler(client: Client, deps: AskDeps): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === ASK_BUTTON_ID) {
        if (!deps.isAllowedUser(interaction.user.id)) {
          await interaction.reply({ content: 'Not authorized.', ephemeral: true })
          return
        }
        const note = new TextInputBuilder()
          .setCustomId('note')
          .setLabel('What should change?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(MODAL_PREFIX + interaction.message.id)
            .setTitle('Tell Claude')
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(note)),
        )
        return
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
        if (!deps.isAllowedUser(interaction.user.id)) {
          await interaction.reply({ content: 'Not authorized.', ephemeral: true })
          return
        }
        await interaction.deferReply({ ephemeral: true })
        const source = await interaction.channel?.messages.fetch(
          interaction.customId.slice(MODAL_PREFIX.length),
        )
        if (!source) {
          await interaction.editReply('Could not find that message.')
          return
        }
        const note = interaction.fields.getTextInputValue('note').trim()
        await deps.startTurn(source, note, `${quoteSource(source)}\n\n${note}`, interaction.user.id)
        await interaction.editReply('Sent. The answer goes in the thread on that message.')
      }
    } catch (err) {
      log.error('tell-claude button failed', { error: describeError(err) })
    }
  })
}
