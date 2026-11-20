import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
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

/** The MCP Bundle manifest (manifest schema 0.3). The given tools list is carried through unchanged. */
export function buildManifest(version, tools) {
  return {
    manifest_version: '0.3',
    name: 'petasats-mcp',
    display_name: 'PetaSats',
    version,
    description: 'Buy BSV with USDC on Base. The kit runs on your computer and keeps its keys there; each trade is an atomic swap with the counterparty.',
    long_description: 'PetaSats buys BSV with USDC on Base through a cross-chain atomic swap with the counterparty. No service ever holds your funds. The kit keeps its keys in a folder on your computer (~/.petasats); back up keys.json, the only copy. Fund it with USDC and a little ETH on Base, ask for a quote, and say yes.',
    author: { name: 'BSVanon', url: 'https://github.com/BSVanon' },
    repository: { type: 'git', url: 'https://github.com/BSVanon/petasats-mcp' },
    homepage: 'https://petasats.io',
    documentation: 'https://github.com/BSVanon/petasats-mcp#readme',
    support: 'https://github.com/BSVanon/petasats-mcp/issues',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'server/petasats-mcp.mjs',
      mcp_config: { command: 'node', args: ['${__dirname}/server/petasats-mcp.mjs'], env: {} },
    },
    tools,
    keywords: ['bsv', 'usdc', 'base', 'atomic-swap', 'non-custodial'],
    license: 'MIT',
    privacy_policies: ['https://github.com/BSVanon/petasats-mcp/blob/main/PRIVACY.md'],
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=22.0.0' } },
  }
}

/** Starts the bundled server fresh (its own PETASATS_HOME) and reads back its tool list. */
export async function toolsFromServer(serverPath) {
  const home = await mkdtemp(join(tmpdir(), 'petasats-mcpb-'))
  let client
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { PETASATS_HOME: home } })
    client = new Client({ name: 'petasats-mcpb-build', version: '1.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    return tools.map((tool) => ({ name: tool.name, description: tool.title ?? tool.name }))
  } finally {
    await client?.close()
    await rm(home, { recursive: true, force: true })
  }
}

const DOS_DATE_1980_01_01 = 0x21
const DOS_TIME_MIDNIGHT = 0
const VERSION_MADE_BY_UNIX = (3 << 8) | 20
const VERSION_NEEDED = 20

function fileExternalAttrs(mode) { return ((0o100000 | mode) << 16) >>> 0 }

/** A standard, byte-reproducible ZIP: DEFLATE entries in sorted path order, fixed 1980-01-01 timestamps, Unix modes. */
export function zipDeterministic(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const localChunks = []
  const centralChunks = []
  let offset = 0
  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.path, 'utf8')
    if (entry.bytes.length > 0xffffffff) throw new Error(`zipDeterministic: ${entry.path} is over 4 GB; ZIP64 is not supported`)
    const compressed = deflateRawSync(entry.bytes, { level: 9 })
    if (compressed.length > 0xffffffff) throw new Error(`zipDeterministic: ${entry.path} compresses to over 4 GB; ZIP64 is not supported`)
    const crc = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10)
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12)
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(fileExternalAttrs(entry.mode), 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBytes)

    offset += local.length + nameBytes.length + compressed.length
  }
  const central = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, central, end])
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const serverPath = join(root, 'dist', 'petasats-mcp.mjs')
  const tools = await toolsFromServer(serverPath)
  const manifest = buildManifest(version, tools)
  const stageDir = join(root, 'dist', 'mcpb')
  await mkdir(join(stageDir, 'server'), { recursive: true })
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const serverBytes = await readFile(serverPath)
  const iconBytes = await readFile(join(root, 'assets', 'petasats-robot-512.png'))
  const licenseBytes = await readFile(join(root, 'LICENSE'))
  await writeFile(join(stageDir, 'manifest.json'), manifestBytes)
  await writeFile(join(stageDir, 'server', 'petasats-mcp.mjs'), serverBytes)
  await writeFile(join(stageDir, 'icon.png'), iconBytes)
  await writeFile(join(stageDir, 'LICENSE'), licenseBytes)
  const zip = zipDeterministic([
    { path: 'manifest.json', bytes: manifestBytes, mode: 0o644 },
    { path: 'server/petasats-mcp.mjs', bytes: serverBytes, mode: 0o755 },
    { path: 'icon.png', bytes: iconBytes, mode: 0o644 },
    { path: 'LICENSE', bytes: licenseBytes, mode: 0o644 },
  ])
  await writeFile(join(root, 'dist', 'petasats-mcp.mcpb'), zip)
  console.log(createHash('sha256').update(zip).digest('hex'))
}

// Run only as a script (tests import the pure functions above); realpath on both sides so a symlinked path still runs it.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`mcpb: ${error.message}`); process.exitCode = 1 })
}
