import Mocha from 'mocha'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function findTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? findTests(join(dir, entry.name)) : entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : []))).flat()
}

const mocha = new Mocha()
for (const file of await findTests(new URL('../tests/', import.meta.url).pathname)) mocha.addFile(file)
await mocha.loadFilesAsync()
process.exitCode = await new Promise((resolve) => mocha.run(resolve))
