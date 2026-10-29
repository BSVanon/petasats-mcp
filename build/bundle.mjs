import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import esbuild from 'esbuild'
const identity = JSON.parse(await readFile(new URL('./door-identity.json', import.meta.url))).doorIdentity
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version
let commit = process.env.GITHUB_SHA || 'unknown'; if (commit === 'unknown') try { commit = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() } catch {}
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
const output = new URL('../dist/petasats-mcp.mjs', import.meta.url).pathname
const meta = new URL('../build/meta.json', import.meta.url).pathname
const result = await esbuild.build({ entryPoints: ['mcp/src/index.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', alias: { 'petasats/sdk': './src/sdk/buyer-sdk.ts' }, define: { __PETASATS_DOOR_IDENTITY__: JSON.stringify(identity) }, banner: { js: '#!/usr/bin/env node\n/* petasats-mcp ' + version + '; commit ' + commit + '; Open BSV License v4 */' }, outfile: output, metafile: true })
await writeFile(meta, JSON.stringify(result.metafile, null, 2) + '\n')
const packageRoot = (input) => { const parts = input.replaceAll('\\', '/').split('/'); const at = parts.lastIndexOf('node_modules'); return at < 0 ? undefined : parts.slice(0, at + (parts[at + 1]?.startsWith('@') ? 3 : 2)).join('/') }
const versions = []; for (const root of new Set(Object.keys(result.metafile.inputs).map(packageRoot).filter(Boolean))) { const manifest = JSON.parse(await readFile(join(process.cwd(), root, 'package.json'), 'utf8')); versions.push(manifest.name + '@' + manifest.version) }
versions.sort(); const expected = JSON.parse(await readFile(new URL('./private-package-versions.json', import.meta.url), 'utf8')); if (JSON.stringify(versions) !== JSON.stringify(expected)) throw new Error('bundled package versions differ from the private build')
let text = await readFile(output, 'utf8'); text = text.replace(/\n#!\/usr\/bin\/env node\n/g, '\n').replace(/^\/\/ .*$/gm, ''); await writeFile(output, text); await chmod(output, 0o755)
const scan = [text, await readFile(new URL('../package.json', import.meta.url), 'utf8'), await readFile(new URL('../README.md', import.meta.url), 'utf8')].join('\n')
for (const forbidden of ['ca' + 'rl', 'ro' + 'bert', 'trea' + 'sury']) if (new RegExp(forbidden, 'i').test(scan)) throw new Error('privacy scan failed')
await writeFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), '# Third-party notices\n\nPackage licenses are recorded by the package manifests included in bundle metadata.\n')

const { writeNotices } = await import('./notices.mjs')
await writeNotices(meta)
const finalArtifacts = [text, await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'), await readFile(new URL('../package.json', import.meta.url), 'utf8'), await readFile(new URL('../README.md', import.meta.url), 'utf8')].join('\n')
for (const forbidden of ['ca' + 'rl', 'ro' + 'bert', 'trea' + 'sury']) if (new RegExp(forbidden, 'i').test(finalArtifacts)) throw new Error('privacy scan failed')
