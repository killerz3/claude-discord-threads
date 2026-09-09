/**
 * Real Discord application commands.
 *
 * The daemon also accepts these as plain text, which works but is invisible:
 * Discord's picker and autocomplete only list commands an app has *registered*.
 * Registering them is what makes the surface discoverable.
 *
 * Registration is guild-scoped, not global. Guild commands appear immediately
 * (global ones take up to an hour to propagate) and they only exist where the
 * bot has actually been opted in, which matches how access.json already thinks
 * about channels.
 *
 * Application commands are visible to everyone who can see the channel, so
 * every invocation is authority-checked against the same allowlist as inbound
 * messages, and replies are ephemeral — the answer goes to the person who
 * asked, not the channel.
 */

import {
  ApplicationCommandOptionType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js'
import { handleCommand, type CommandContext } from './commands'
import { log, describeError } from '../log'

type OptionSpec = { name: string; description: string; required?: boolean }
type CommandSpec = { name: string; description: string; option?: OptionSpec }

/**
 * The registered surface. `/help` is omitted deliberately — Discord's own
 * picker *is* the help, and a command whose only job is to list the commands
 * next to a list of the commands reads as noise.
 */
export const SLASH_COMMANDS: CommandSpec[] = [
  { name: 'status', description: 'Session, model, working directory and turn counts for this thread' },
  {
    name: 'cwd',
    description: 'Show or change the working directory for this thread',
    option: { name: 'path', description: 'Absolute path, or ~ for home' },
  },
  { name: 'clear', description: 'Forget the conversation but keep the thread' },
  { name: 'stop', description: 'Cancel the turn currently running in this thread' },
  { name: 'done', description: 'Archive this thread' },
  { name: 'usage', description: 'Plan limits: 5-hour and weekly windows' },
  { name: 'cost', description: 'What this thread has spent' },
  { name: 'context', description: 'Context window used by this conversation' },
  {
    name: 'model',
    description: 'Show, list or set the model for this thread',
    option: { name: 'name', description: 'Model name, "list", or "default" to reset' },
  },
  {
    name: 'permissions',
    description: 'Show or set the permission mode for this thread',
    option: { name: 'mode', description: 'auto, default, acceptEdits, plan or dontAsk' },
  },
  { name: 'threads', description: 'List every open thread' },
  { name: 'compact', description: 'Summarise this conversation to free up context (costs tokens)' },
]

function toPayload(spec: CommandSpec) {
  return {
    name: spec.name,
    description: spec.description.slice(0, 100),
    type: 1,
    options: spec.option
      ? [
          {
            name: spec.option.name,
            description: spec.option.description.slice(0, 100),
            type: ApplicationCommandOptionType.String,
            required: spec.option.required ?? false,
          },
        ]
      : [],
  }
}

/**
 * Publish the command set to each guild the bot is opted into.
 *
 * A bulk overwrite, so removing a command here removes it from Discord too and
 * the registered set cannot drift from this file.
 */
export async function registerGuildCommands(client: Client, guildIds: string[]): Promise<void> {
  const app = client.application
  if (!app) {
    log.warn('cannot register slash commands: application not ready')
    return
  }
  const body = SLASH_COMMANDS.map(toPayload)
  for (const guildId of new Set(guildIds)) {
    try {
      await app.commands.set(body, guildId)
      log.info('registered slash commands', { guild: guildId, count: body.length })
    } catch (err) {
      // Usually means the app was installed without the applications.commands
      // scope. Plain-text commands still work, so this is not fatal.
      log.warn('slash command registration failed', {
        guild: guildId,
        error: describeError(err),
        hint: 're-invite the bot with the applications.commands scope',
      })
    }
  }
}

export type SlashDeps = {
  /** Same allowlist that gates inbound messages. */
  isAllowedUser: (userId: string) => boolean
  /** Build the context the text commands already use. */
  contextFor: (conversationId: string) => CommandContext
  /** Run a command that has to reach the model, e.g. /compact. */
  enqueueTurn: (conversationId: string, content: string, userId: string) => Promise<boolean>
}

export function attachSlashHandler(client: Client, deps: SlashDeps): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return
    await handle(interaction, deps).catch(err =>
      log.error('slash command failed', {
        command: interaction.commandName,
        error: describeError(err),
      }),
    )
  })
}

async function handle(
  interaction: ChatInputCommandInteraction,
  deps: SlashDeps,
): Promise<void> {
  // Anyone in the channel can see and invoke these, so the check is the same
  // one the inbound gate applies.
  if (!deps.isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral })
    return
  }

  const conversationId = interaction.channelId
  const arg = interaction.options.getString(
    SLASH_COMMANDS.find(c => c.name === interaction.commandName)?.option?.name ?? 'value',
  )
  const text = `/${interaction.commandName}${arg ? ` ${arg}` : ''}`

  // /compact is executed by Claude Code itself, so it has to become a real turn
  // rather than a daemon answer. Its result lands in the thread as usual.
  if (interaction.commandName === 'compact') {
    const queued = await deps.enqueueTurn(conversationId, text, interaction.user.id)
    await interaction.reply({
      content: queued
        ? 'Compacting — the result will appear in this thread.'
        : 'Nothing to compact: this thread has no conversation yet.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Some commands spawn a CLI to answer, which can outrun Discord's 3-second
  // reply deadline, so acknowledge first and edit the answer in.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const outcome = await handleCommand(text, deps.contextFor(conversationId))
  const reply = outcome.handled ? outcome.reply : `Unknown command \`${text}\`.`
  // Discord caps a message at 2000 characters; these answers are short, but
  // /threads on a busy server could approach it.
  await interaction.editReply(reply.slice(0, 1900))
}
