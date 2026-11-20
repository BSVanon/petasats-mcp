import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOSTED_TOOL_REFUSAL } from '../src/hosted.js'

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const DEST_BASE = '0x3333333333333333333333333333333333333333'
const DEST_BSV = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'

/**
 * Runs the real entry point's `close` command against a kit folder that does not exist yet, in a temporary home, so a
 * wallet made by mistake shows as a new folder. Both cases below end before any rail or network is touched.
 */
function runClose(args: string[], hosted: boolean): { status: number | null; stdout: string; stderr: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'petasats-close-cli-'))
  const home = join(dir, 'kit')
  const env: NodeJS.ProcessEnv = { ...process.env, PETASATS_HOME: home, HOME: dir, USERPROFILE: dir }
  delete env.GLAMA_VERSION
  delete env.PETASATS_QUOTE_ONLY
  if (hosted) env.PETASATS_QUOTE_ONLY = '1'
  const run = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'close', ...args], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, home }
}

test('T4 close checks its usage before the runtime is created: a wrong argument count makes no wallet', () => {
  for (const args of [[], [DEST_BASE], [DEST_BASE, DEST_BSV, 'extra']]) {
    const run = runClose(args, false)
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, /usage: npx petasats-mcp close <base_address> <bsv_address>/)
    assert.equal(existsSync(run.home), false, `no kit folder for ${args.length} arguments`)
  }
})

test('N1 a shared-server copy refuses close, as the close_kit tool does, and makes no wallet', () => {
  const run = runClose([DEST_BASE, DEST_BSV], true)
  assert.equal(run.status, 1, run.stderr)
  assert.equal(run.stdout.trim(), HOSTED_TOOL_REFUSAL)
  assert.equal(existsSync(run.home), false)
})
