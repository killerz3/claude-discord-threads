/**
 * Runs before every test file. `src/config` reads DISCORD_STATE_DIR once, at
 * import, and bun runs all test files in one process — so without this, the
 * first file to import config pins the operator's live state dir, and
 * access.test.ts overwrites their real access.json.
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.DISCORD_STATE_DIR = mkdtempSync(join(tmpdir(), 'discord-threads-test-'))
