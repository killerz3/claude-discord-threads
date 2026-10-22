/**
 * Who the gate lets through.
 *
 * This is the only boundary between a Discord message and a Claude Code worker
 * running in permissionMode 'auto' on the operator's machine, so reaching it is
 * equivalent to a shell there. Every case below is a safety property, not a
 * feature — most importantly that a guild channel is never open to the room
 * just because no per-channel allowlist was typed.
 */

import { test, expect, describe, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const STATE = process.env.DISCORD_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'access-test-'))
process.env.DISCORD_STATE_DIR = STATE

const { gate } = await import('../src/discord/access')
const { ACCESS_FILE } = await import('../src/config')
import { ChannelType, type Client, type Message } from 'discord.js'

const OWNER = '111111111111111111'
const STRANGER = '222222222222222222'
const FRIEND = '333333333333333333'
const CHANNEL = '999999999999999999'

function writeAccess(a: Record<string, unknown>): void {
  if (ACCESS_FILE !== join(STATE, 'access.json')) throw new Error('Refusing to write outside test state')
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2))
}

/** A guild message. `mentions` reports a hit so requireMention is satisfied. */
function guildMsg(authorId: string, opts: { mentioned?: boolean } = {}): Message {
  return {
    author: { id: authorId, bot: false },
    channelId: CHANNEL,
    content: 'hello',
    channel: { type: ChannelType.GuildText, isThread: () => false },
    mentions: { has: () => opts.mentioned ?? true },
    reference: null,
  } as unknown as Message
}

function dmMsg(authorId: string): Message {
  return {
    author: { id: authorId, bot: false },
    channelId: 'dm-channel',
    content: 'hello',
    channel: { type: ChannelType.DM, isThread: () => false },
    mentions: { has: () => false },
    reference: null,
  } as unknown as Message
}

const client = { user: { id: 'bot' } } as unknown as Client

beforeEach(() => {
  writeAccess({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: {}, pending: {} })
})

describe('guild channels', () => {
  test('a channel that was never opted in is closed', async () => {
    const r = await gate(client, guildMsg(OWNER))
    expect(r.action).toBe('drop')
  })

  test('an empty per-channel allowFrom does NOT open the channel to the room', async () => {
    writeAccess({
      dmPolicy: 'allowlist',
      allowFrom: [OWNER],
      groups: { [CHANNEL]: { requireMention: true, allowFrom: [] } },
      pending: {},
    })
    // The owner still gets through: the empty list falls back to their allowlist.
    expect((await gate(client, guildMsg(OWNER))).action).toBe('deliver')
    // A bystander who @mentions the bot in the same channel does not.
    expect((await gate(client, guildMsg(STRANGER))).action).toBe('drop')
  })

  test('with no allowlist anywhere, nobody is allowed', async () => {
    writeAccess({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: { [CHANNEL]: { requireMention: false, allowFrom: [] } },
      pending: {},
    })
    expect((await gate(client, guildMsg(STRANGER))).action).toBe('drop')
    expect((await gate(client, guildMsg(OWNER))).action).toBe('drop')
  })

  test('an explicit per-channel allowFrom overrides the owner allowlist', async () => {
    writeAccess({
      dmPolicy: 'allowlist',
      allowFrom: [OWNER],
      groups: { [CHANNEL]: { requireMention: false, allowFrom: [FRIEND] } },
      pending: {},
    })
    expect((await gate(client, guildMsg(FRIEND))).action).toBe('deliver')
    expect((await gate(client, guildMsg(STRANGER))).action).toBe('drop')
  })

  test('an allowlisted sender who does not mention the bot is still dropped', async () => {
    writeAccess({
      dmPolicy: 'allowlist',
      allowFrom: [OWNER],
      groups: { [CHANNEL]: { requireMention: true, allowFrom: [] } },
      pending: {},
    })
    const r = await gate(client, guildMsg(OWNER, { mentioned: false }))
    expect(r.action).toBe('drop')
  })

  test('dmPolicy disabled closes guild channels too, not just DMs', async () => {
    writeAccess({
      dmPolicy: 'disabled',
      allowFrom: [OWNER],
      groups: { [CHANNEL]: { requireMention: false, allowFrom: [OWNER] } },
      pending: {},
    })
    expect((await gate(client, guildMsg(OWNER))).action).toBe('drop')
  })
})

describe('DMs', () => {
  test('an allowlisted sender is delivered', async () => {
    expect((await gate(client, dmMsg(OWNER))).action).toBe('deliver')
  })

  test('under allowlist policy an unknown sender is dropped silently', async () => {
    const r = await gate(client, dmMsg(STRANGER))
    expect(r.action).toBe('drop')
  })

  test('under pairing policy an unknown sender gets a code, not a turn', async () => {
    writeAccess({ dmPolicy: 'pairing', allowFrom: [OWNER], groups: {}, pending: {} })
    const r = await gate(client, dmMsg(STRANGER))
    expect(r.action).toBe('pair')
  })

  test('pairing answers an unapproved sender at most twice, then goes quiet', async () => {
    writeAccess({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
    expect((await gate(client, dmMsg(STRANGER))).action).toBe('pair')
    expect((await gate(client, dmMsg(STRANGER))).action).toBe('pair')
    expect((await gate(client, dmMsg(STRANGER))).action).toBe('drop')
  })

  test('pending codes are capped, so strangers cannot flood the file', async () => {
    writeAccess({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
    for (const id of ['1', '2', '3']) await gate(client, dmMsg(id))
    expect((await gate(client, dmMsg('4'))).action).toBe('drop')
  })
})
