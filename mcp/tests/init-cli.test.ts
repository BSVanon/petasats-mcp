// `npx petasats-mcp init` must agree with the automatic first-start path: a kit folder that already holds kit
// files but lost keys.json never gets replacement keys, through the real CLI subprocess, not just the function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buyerHome, initialiseBuyerHome, type BuyerHome } from 'petasats/sdk'

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))

/** Runs the real entry point's `init` command against an existing kit home, as a real subprocess. */
function runInit(home: string): { status: number | null; stdout: string; stderr: string } {
  const throwaway = mkdtempSync(join(tmpdir(), 'petasats-init-cli-env-'))
  const env: NodeJS.ProcessEnv = { ...process.env, PETASATS_HOME: home, HOME: throwaway, USERPROFILE: throwaway }
  delete env.GLAMA_VERSION
  delete env.PETASATS_QUOTE_ONLY
  const run = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'init'], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** Runs the real entry point's `status` command against a kit home, as a real subprocess. */
function runStatus(home: string): { status: number | null; stdout: string; stderr: string } {
  const throwaway = mkdtempSync(join(tmpdir(), 'petasats-status-cli-env-'))
  const env: NodeJS.ProcessEnv = { ...process.env, PETASATS_HOME: home, HOME: throwaway, USERPROFILE: throwaway }
  delete env.GLAMA_VERSION
  delete env.PETASATS_QUOTE_ONLY
  const run = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'status'], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

type TreeEntry = { kind: 'file'; content: string } | { kind: 'dir'; mode: number }
/**
 * Every entry under dir, recursively: a file's byte-identical content, and (M1) a folder's own presence and mode.
 * Recording folders too means a mutation that creates a folder earlier than it should (R1), or that would have
 * created one that was not already there, is visible here even when the function still ultimately refuses.
 */
function snapshotTree(dir: string): Record<string, TreeEntry> {
  const out: Record<string, TreeEntry> = {}
  const walk = (base: string, prefix: string): void => {
    for (const name of readdirSync(base)) {
      const full = join(base, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(full)
      if (stat.isDirectory()) { out[rel] = { kind: 'dir', mode: stat.mode & 0o777 }; walk(full, rel) }
      else out[rel] = { kind: 'file', content: readFileSync(full, 'utf8') }
    }
  }
  walk(dir, '')
  return out
}

const refusalText = (home: string): string =>
  `${home} holds kit files but no keys.json, so no new keys were created. Restore keys.json from your backup, or use a new, empty folder for a new kit.`

/**
 * The kit's 3 subfolders only, built from nothing with plain mkdirSync — not secured to 0700 the way safeMkdir
 * would (M1). A NOT_NEW case then holds only its one named entry plus this baseline, no config.json and no prior
 * init, so the named entry alone is what disqualifies it. The plain (non-0700) mode also means a mutation that
 * runs safeMkdir before the not-new check (R1) is caught by the mode it would "fix" in the snapshot above, even
 * though every one of these folders already existed and the function still ultimately refuses.
 */
function buildEmptyKitSubfolders(home: string): BuyerHome {
  const paths = buyerHome(home)
  mkdirSync(paths.swapsDir, { recursive: true }); mkdirSync(paths.settlementDir); mkdirSync(paths.withdrawalsDir)
  return paths
}

const NOT_NEW: Array<[string, (home: BuyerHome) => void]> = [
  ['swaps/x.json', (home) => writeFileSync(join(home.swapsDir, 'x.json'), '{}')],
  ['withdrawals/x.json', (home) => writeFileSync(join(home.withdrawalsDir, 'x.json'), '{}')],
  ['settlement/x.json', (home) => writeFileSync(join(home.settlementDir, 'x.json'), '{}')],
  ['STOP', (home) => writeFileSync(home.stopPath, '{"at":1}')],
  ['close.json', (home) => writeFileSync(join(home.home, 'close.json'), '{}')],
  ['limits.json', (home) => writeFileSync(home.limitsPath, '{"format":"petasats.limits/1"}')],
  ['config.json', (home) => writeFileSync(home.configPath, '{}')],
  ['an unknown file', (home) => writeFileSync(join(home.home, 'mystery.unknown'), 'x')],
]

for (const [label, addEntry] of NOT_NEW) {
  test(`init refuses new keys for ${label}: exit 1, no keys.json, nothing created or changed`, () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-init-cli-not-new-'))
    const home = buildEmptyKitSubfolders(join(parent, 'home'))
    addEntry(home)
    const before = snapshotTree(home.home)
    const run = runInit(home.home)
    assert.equal(run.status, 1, `${label}: ${run.stderr}`)
    assert.equal(run.stdout, '', label)
    assert.ok(run.stderr.includes(refusalText(home.home)), `${label}: ${run.stderr}`)
    assert.equal(existsSync(home.keysPath), false, label)
    assert.deepEqual(snapshotTree(home.home), before, label)
  })
}

test('init refuses a bare limits.json alone, with no prior init: it disqualifies on its own, not merely alongside config.json', () => {
  // The parametrized limits.json case above always runs after a full init, so config.json is already present and
  // would disqualify the folder by itself either way. This isolates limits.json as the ONLY entry, so a mutation
  // that wrongly treats limits.json as harmless (the way .DS_Store is) flips this case to new and is caught here.
  const home = mkdtempSync(join(tmpdir(), 'petasats-init-cli-limits-only-'))
  writeFileSync(join(home, 'limits.json'), '{"format":"petasats.limits/1"}')
  const before = snapshotTree(home)
  const run = runInit(home)
  assert.equal(run.status, 1, run.stderr)
  assert.equal(run.stdout, '')
  assert.ok(run.stderr.includes(refusalText(home)), run.stderr)
  assert.equal(existsSync(join(home, 'keys.json')), false)
  assert.deepEqual(snapshotTree(home), before)
})

const NEW_GETS_KEYS: Array<[string, (parent: string) => string]> = [
  ['a missing folder', (parent) => join(parent, 'missing')],
  ['an empty folder', (parent) => { const dir = join(parent, 'empty'); mkdirSync(dir); return dir }],
  ['.DS_Store only', (parent) => { const dir = join(parent, 'dsstore'); mkdirSync(dir); writeFileSync(join(dir, '.DS_Store'), ''); return dir }],
  ['empty kit subfolders (swaps, settlement, withdrawals, all three)', (parent) => {
    const dir = join(parent, 'subfolders')
    mkdirSync(join(dir, 'swaps'), { recursive: true }); mkdirSync(join(dir, 'settlement')); mkdirSync(join(dir, 'withdrawals'))
    return dir
  }],
]

for (const [label, makeDir] of NEW_GETS_KEYS) {
  test(`init creates a new wallet, with keys.json at mode 600, on ${label}`, () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-init-cli-new-'))
    const home = makeDir(parent)
    const run = runInit(home)
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout)
    assert.equal(result.ok, true, label)
    assert.equal(existsSync(join(home, 'keys.json')), true, label)
    if (process.platform !== 'win32') assert.equal(lstatSync(join(home, 'keys.json')).mode & 0o777, 0o600, label)
  })
}

test('m1 status run before setup never blocks a later init: a missing folder is left untouched by status, and init still succeeds', () => {
  const parent = mkdtempSync(join(tmpdir(), 'petasats-status-then-init-'))
  const home = join(parent, 'fresh')
  const status = runStatus(home)
  assert.equal(status.status, 0, status.stderr)
  assert.deepEqual(JSON.parse(status.stdout), { swaps: [] }, status.stdout)
  assert.equal(existsSync(home), false) // status alone must create nothing: not the home dir, not swaps/, not settlement/
  const run = runInit(home)
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(home, 'keys.json')), true)
  if (process.platform !== 'win32') assert.equal(lstatSync(join(home, 'keys.json')).mode & 0o777, 0o600)
})

test('n1 init redacts any OTHER fatal error the same way the normal catch-all does; only the approved refusal prints unredacted', () => {
  // A keys.json loosened to 0o644 fails secureFileText's permission check, not the not-new refusal this file is
  // otherwise about. It is the simplest way to reach the "every other error" branch of the init catch block.
  const home = initialiseBuyerHome(mkdtempSync(join(tmpdir(), 'petasats-init-cli-unreadable-')))
  if (process.platform === 'win32') return // POSIX permission bits are not meaningful on win32
  chmodSync(home.keysPath, 0o644)
  const run = runInit(home.home)
  assert.equal(run.status, 1, run.stderr)
  assert.equal(run.stdout, '')
  assert.ok(!run.stderr.includes('keys.json'), run.stderr)
  assert.ok(run.stderr.includes('[redacted credential source]'), run.stderr)
})
