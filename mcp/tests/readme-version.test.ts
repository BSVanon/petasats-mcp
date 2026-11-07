import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/version.js'

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('every README command runs the release it ships with', () => {
  // The development tree keeps the README as a template; the published repository has it at its root.
  const path = [join(MCP_ROOT, 'public', 'template', 'README.md'), join(MCP_ROOT, '..', 'README.md')].find((p) => existsSync(p))
  assert.ok(path)
  const readme = readFileSync(path, 'utf8')
  assert.deepEqual(readme.match(/(?:npx|-y) petasats-mcp(?!@)|"petasats-mcp"/g) ?? [], [], 'a command names the package without a version')
  const versions = [...readme.matchAll(/petasats-mcp@(\d+\.\d+\.\d+)/g)].map((m) => m[1])
  assert.ok(versions.length > 0)
  assert.deepEqual([...new Set(versions)], [VERSION])
})
