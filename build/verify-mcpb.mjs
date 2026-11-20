import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A minimal reader for the standard ZIP this kit writes: parses the central directory, inflates, checks each CRC. */
export function readZip(buffer) {
  if (buffer.length < 22) throw new Error('not a ZIP file (too short)')
  const end = buffer.subarray(buffer.length - 22)
  if (end.readUInt32LE(0) !== 0x06054b50) throw new Error('missing end-of-central-directory record')
  const totalEntries = end.readUInt16LE(10)
  const centralOffset = end.readUInt32LE(16)
  const entries = []
  let pointer = centralOffset
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error(`malformed central directory entry ${i}`)
    const expectedCrc = buffer.readUInt32LE(pointer + 16)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const uncompressedSize = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const externalAttrs = buffer.readUInt32LE(pointer + 38)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const path = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`malformed local header for ${path}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const bytes = inflateRawSync(compressed)
    if (bytes.length !== uncompressedSize) throw new Error(`size mismatch for ${path}`)
    if (crc32(bytes) !== expectedCrc) throw new Error(`CRC-32 mismatch for ${path}`)
    entries.push({ path, bytes, mode: (externalAttrs >>> 16) & 0o7777 })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function sameNames(a, b) { return a.length === b.length && a.every((name, i) => name === b[i]) }

/** Checks the bundle the way a user's machine will use it: unpack it, then run the server from the unpacked copy. */
export async function verifyBundle(bundlePath, serverSourcePath, packageJsonPath) {
  const bundleBytes = await readFile(bundlePath)
  const entries = readZip(bundleBytes)
  const names = entries.map((entry) => entry.path).sort()
  const expected = ['LICENSE', 'icon.png', 'manifest.json', 'server/petasats-mcp.mjs'].sort()
  if (!sameNames(names, expected)) throw new Error(`unexpected bundle entries: ${names.join(', ')}`)
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const serverSource = await readFile(serverSourcePath)
  if (!byPath.get('server/petasats-mcp.mjs').bytes.equals(serverSource)) throw new Error('bundled server/petasats-mcp.mjs differs from dist/petasats-mcp.mjs')
  const manifest = JSON.parse(byPath.get('manifest.json').bytes.toString('utf8'))
  const packageVersion = JSON.parse(await readFile(packageJsonPath, 'utf8')).version
  if (manifest.version !== packageVersion) throw new Error(`manifest version ${manifest.version} does not match package.json version ${packageVersion}`)

  const extractDir = await mkdtemp(join(tmpdir(), 'petasats-mcpb-extract-'))
  const home = await mkdtemp(join(tmpdir(), 'petasats-mcpb-home-'))
  let client
  try {
    for (const entry of entries) {
      const target = join(extractDir, entry.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.bytes)
    }
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(extractDir, 'server', 'petasats-mcp.mjs')], env: { PETASATS_HOME: home } })
    client = new Client({ name: 'petasats-mcpb-verify', version: '1.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    const toolNames = tools.map((tool) => tool.name).sort()
    const manifestToolNames = manifest.tools.map((tool) => tool.name).sort()
    if (!sameNames(toolNames, manifestToolNames)) throw new Error('tools/list names differ from the manifest')
    const result = await client.callTool({ name: 'wallet_info', arguments: {} })
    const info = JSON.parse(result.content?.[0]?.text ?? '{}')
    if (typeof info.baseAddress !== 'string' || !info.baseAddress.startsWith('0x')) throw new Error('wallet_info did not return a 0x-prefixed baseAddress')
  } finally {
    await client?.close()
    await rm(extractDir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
  return createHash('sha256').update(bundleBytes).digest('hex')
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const sha256 = await verifyBundle(join(root, 'dist', 'petasats-mcp.mcpb'), join(root, 'dist', 'petasats-mcp.mjs'), join(root, 'package.json'))
  console.log(`verify-mcpb: OK ${sha256}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`verify-mcpb: ${error.message}`); process.exitCode = 1 })
}
