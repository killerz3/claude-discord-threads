# Agent SDK surface this daemon depends on

Pinned against `@anthropic-ai/claude-agent-sdk@0.3.266` by reading the shipped
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, not from memory or docs
prose. Re-check these when bumping the SDK.

## Entry point

```ts
function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
```

An `AsyncIterable` prompt is what gives us a session that stays alive across many
Discord messages: push a `SDKUserMessage` per inbound message and read one
`result` back per turn.

Options we rely on: `resume` (session id), `cwd`, `settingSources`,
`allowedTools` / `disallowedTools`, `permissionMode`, `permissionPrompts`
(`'host' | 'none'`), `canUseTool`, `plugins`.

## The delivery payload

```ts
type SDKResultSuccess = {
  type: 'result'
  subtype: 'success'
  is_error: boolean
  api_error_status?: number | null   // 429 lands here
  result: string                     // ← what we post to Discord
  num_turns: number
  total_cost_usd: number
  permission_denials: SDKPermissionDenial[]
  session_id: string                 // ← persisted on the thread row
  uuid: UUID
}
```

`result` is the whole point: it is the turn's final assistant text. The daemon
posts it, so the model has no reply tool to forget. `session_id` is how a thread
resumes after the worker is reaped or the daemon restarts.

Note `total_cost_usd` and `modelUsage` are **cumulative across turns** in a
streaming-input session — read the latest result, never sum them.

## Permissions

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    suggestions?: PermissionUpdate[]
    title?: string          // "Claude wants to read foo.txt"
    displayName?: string    // "Read file" — good button label
    description?: string
    blockedPath?: string
    decisionReason?: string
    toolUseID: string
    requestId: string
  },
) => Promise<PermissionResult | null>

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
```

Three things this buys the Discord UI:

- `title` / `displayName` are the bridge's own rendered prompt text. Use them
  instead of reconstructing a sentence from `toolName` + `input`.
- `suggestions` is what an **Always allow** button should return as
  `updatedPermissions`, so the same tool stops prompting for the session.
- `signal` is the timeout hook: abort it and the pending Discord buttons resolve
  to a deny.

Two hazards:

- Returning `null` **fails closed** (no response is sent). Always return an
  explicit `deny` on timeout rather than falling through.
- Callbacks must be **idempotent per `requestId`**. After a reconnect the SDK
  redelivers control requests whose responses were lost, so the daemon keys
  pending prompts on `requestId` (hence the `permissions` table).
- `permissionPrompts: 'none'` means `canUseTool` is *never called* and anything
  that would prompt is denied. That is the wrong mode for us — we want `'host'`.

## Auth

This machine authenticates with a Max subscription OAuth credential
(`~/.claude/.credentials.json`), not an API key, and headless operation under it
is verified working. Consequences:

- Do **not** set `ANTHROPIC_API_KEY` — it would move billing to metered API spend.
- Do **not** use `--bare` / bare mode. It deliberately refuses OAuth and keychain
  reads and accepts only `ANTHROPIC_API_KEY`; it is the one flag that breaks this
  setup and is easy to add by accident while "isolating" a worker.
- `claude setup-token` mints a one-year `CLAUDE_CODE_OAUTH_TOKEN` if a
  credential independent of interactive login refresh is wanted later.

## Rate limits

A Max subscription is governed by rolling session and weekly windows, not the
per-minute RPM/ITPM tiers that apply to API-console organisations. So the daemon
does not model a budget; it reacts: on `api_error_status === 429` it honours
`retry-after`, returns the turn to `queued`, and posts a retry notice into the
thread. `MAX_LIVE_WORKERS` exists to stop a burst of Discord threads from
starving the operator's own interactive sessions of the same quota.
