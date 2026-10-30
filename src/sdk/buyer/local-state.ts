import * as fs from 'fs'
import { join } from 'path'
import { PrivateKey } from '@bsv/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { writeSettlementRecordAtomically } from '../../bridge/atomic-record-write'
import type { BuyerStore, BuyerSwapRecord } from './types'
import { DEFAULT_BUYER_BASE_RPC_URLS } from './runtime/evm-rails'

export const DOOR_IDENTITY_PLACEHOLDER = 'RELEASE_FILL_DOOR_IDENTITY_PUBKEY'
/** Replaced only by the release bundler. The guard preserves a useful unbundled/test default. */
declare const __PETASATS_DOOR_IDENTITY__: string | undefined
export const RELEASED_DOOR_IDENTITY = typeof __PETASATS_DOOR_IDENTITY__ === 'string'
  ? __PETASATS_DOOR_IDENTITY__
  : DOOR_IDENTITY_PLACEHOLDER
export interface BuyerDiskConfig { doorIdentity?: string; baseRpcUrls: string[]; bsvSources: string[]; anvilHost: string; capUsdPerSwap: number }
export interface BuyerKeys { identityWif: string; evmPrivateKey: `0x${string}`; bsvWif: string }
export interface BuyerHome { home: string; keysPath: string; configPath: string; limitsPath: string; stopPath: string; swapsDir: string; settlementDir: string; withdrawalsDir: string }

export function buyerHome(home = process.env.PETASATS_HOME || join(process.env.HOME || '.', '.petasats')): BuyerHome {
  return { home, keysPath: join(home, 'keys.json'), configPath: join(home, 'config.json'), limitsPath: join(home, 'limits.json'), stopPath: join(home, 'STOP'), swapsDir: join(home, 'swaps'), settlementDir: join(home, 'settlement'), withdrawalsDir: join(home, 'withdrawals') }
}
type BuyerHomeFs = Pick<typeof fs, 'chmodSync' | 'existsSync' | 'mkdirSync' | 'openSync' | 'readFileSync' | 'writeFileSync' | 'closeSync' | 'readdirSync' | 'renameSync' | 'fsyncSync' | 'lstatSync' | 'fstatSync' | 'fchmodSync'>

function safeMkdir(path: string, fileSystem: BuyerHomeFs = fs): void {
  const assertDirectory = (): void => {
    const stat = fileSystem.lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe local directory ${path}; replace it with a directory and chmod 700 ${path}`)
  }
  try { assertDirectory() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  fileSystem.mkdirSync(path, { recursive: true, mode: 0o700 })
  assertDirectory()
  const fsConstants = fs.constants as typeof fs.constants & { O_DIRECTORY?: number; O_NOFOLLOW?: number }
  if (fsConstants.O_DIRECTORY !== undefined && fsConstants.O_NOFOLLOW !== undefined) {
    const fd = fileSystem.openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    try {
      if (!fileSystem.fstatSync(fd).isDirectory()) throw new Error(`unsafe local directory ${path}; replace it with a directory and chmod 700 ${path}`)
      fileSystem.fchmodSync(fd, 0o700)
    } finally { fileSystem.closeSync(fd) }
  } else fileSystem.chmodSync(path, 0o700)
}
/** Exclusively create a file, then make both its contents and its directory entry power-loss durable. */
function writeNew(path: string, value: unknown, mode: number, fileSystem: BuyerHomeFs = fs): void {
  const fd = fileSystem.openSync(path, 'wx', mode)
  try {
    fileSystem.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' })
    fileSystem.chmodSync(path, mode)
    fileSystem.fsyncSync(fd)
  } finally { fileSystem.closeSync(fd) }
  const directoryFd = fileSystem.openSync(join(path, '..'), 'r')
  try { fileSystem.fsyncSync(directoryFd) } finally { fileSystem.closeSync(directoryFd) }
}

function assertReadableBuyerKeys(keys: unknown): asserts keys is BuyerKeys {
  if (!keys || typeof keys !== 'object') throw new Error('buyer keys file is invalid')
  const candidate = keys as Partial<BuyerKeys>
  if (typeof candidate.identityWif !== 'string' || typeof candidate.bsvWif !== 'string' || typeof candidate.evmPrivateKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(candidate.evmPrivateKey)) {
    throw new Error('buyer keys file is incomplete or invalid')
  }
  // Parse both WIFs now: initialization must never claim success with a file
  // that it would later fail to use, and it must never replace that file.
  PrivateKey.fromWif(candidate.identityWif)
  PrivateKey.fromWif(candidate.bsvWif)
  privateKeyToAccount(candidate.evmPrivateKey)
}
/** Creates local keys once. No key is logged, returned by CLI output, or sent to a dependency. */
export function initialiseBuyerHome(homePath?: string, fileSystem: BuyerHomeFs = fs): BuyerHome {
  const paths = buyerHome(homePath)
  safeMkdir(paths.home, fileSystem); safeMkdir(paths.swapsDir, fileSystem); safeMkdir(paths.settlementDir, fileSystem); safeMkdir(paths.withdrawalsDir, fileSystem)
  if (!fileSystem.existsSync(paths.keysPath)) {
    const evmPrivateKey = generatePrivateKey()
    const keys: BuyerKeys = { identityWif: PrivateKey.fromRandom().toWif(), evmPrivateKey, bsvWif: PrivateKey.fromRandom().toWif() }
    writeNew(paths.keysPath, keys, 0o600, fileSystem)
  } else {
    // An existing partial/unreadable file is evidence of an interrupted or
    // damaged initialization.  Regenerating would silently orphan its address.
    assertReadableBuyerKeys(JSON.parse(fileSystem === fs ? secureFileText(paths.keysPath) : fileSystem.readFileSync(paths.keysPath, 'utf8')))
  }
  if (!fileSystem.existsSync(paths.configPath)) writeNew(paths.configPath, {
    doorIdentity: RELEASED_DOOR_IDENTITY, baseRpcUrls: [...DEFAULT_BUYER_BASE_RPC_URLS],
    bsvSources: ['https://api.whatsonchain.com', 'https://anvil.sendbsv.com'], anvilHost: 'https://anvil.sendbsv.com', capUsdPerSwap: 100,
  } satisfies BuyerDiskConfig, 0o600, fileSystem)
  return paths
}
export function secureFileText(path: string): string {
  const before = fs.lstatSync(path)
  const owner = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`unsafe local file ${path}; replace it with a regular file and chmod 600 ${path}`)
  if ((before.mode & 0o077) !== 0 || (owner !== undefined && before.uid !== owner)) throw new Error(`unsafe permissions on ${path}; run chmod 600 ${path}`)
  const nofollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  const fd = fs.openSync(path, fs.constants.O_RDONLY | nofollow)
  try {
    const after = fs.fstatSync(fd)
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || (after.mode & 0o077) !== 0 || (owner !== undefined && after.uid !== owner)) {
      throw new Error(`unsafe local file ${path}; replace it with a regular file and chmod 600 ${path}`)
    }
    return fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
}

/** Validate runtime directories before a sensitive file inside them is opened. */
export function assertSecureBuyerHome(paths: BuyerHome): void {
  const owner = typeof process.getuid === 'function' ? process.getuid() : undefined
  for (const path of [paths.home, paths.swapsDir, paths.settlementDir, paths.withdrawalsDir]) {
    const stat = fs.lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (owner !== undefined && stat.uid !== owner)) {
      throw new Error(`unsafe local directory ${path}; run chmod 700 ${path}`)
    }
  }
}
/** Create the one added runtime directory before the regular owner-only assertion. */
export function ensureBuyerRuntimeDirs(paths: BuyerHome): void { safeMkdir(paths.withdrawalsDir) }
export function readBuyerKeys(paths: BuyerHome): BuyerKeys { return JSON.parse(secureFileText(paths.keysPath)) as BuyerKeys }
export function readBuyerConfig(paths: BuyerHome): BuyerDiskConfig {
  const parsed = JSON.parse(secureFileText(paths.configPath)) as Record<string, unknown>
  return { ...parsed, doorIdentity: typeof parsed.doorIdentity === 'string' ? parsed.doorIdentity : undefined } as BuyerDiskConfig
}
export function buyerAddresses(keys: BuyerKeys): { baseAddress: string; bsvAddress: string } {
  return { baseAddress: privateKeyToAccount(keys.evmPrivateKey).address, bsvAddress: PrivateKey.fromWif(keys.bsvWif).toAddress() }
}
/** 0600 JSON store.  A replacement is durable only after its file and containing directory are fsynced. */
export function makeFileBuyerStore(paths: BuyerHome): BuyerStore {
  safeMkdir(paths.home); safeMkdir(paths.swapsDir); safeMkdir(paths.settlementDir)
  const file = (id: string): string => { if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid swap id'); return join(paths.swapsDir, `${id}.json`) }
  const decode = (source: string): BuyerSwapRecord => {
    const record = JSON.parse(source) as BuyerSwapRecord
    // JSON has no bigint. Only the quote's atomic values are revived; swap `amountIn` deliberately remains its durable decimal string.
    const quote = record.quote as unknown as Record<string, unknown>
    for (const key of ['amountIn', 'amountOut', 'usdcBaseUnits', 'bsvSats']) {
      if (typeof quote[key] !== 'string' || !/^\d+$/.test(quote[key] as string)) throw new Error(`invalid buyer swap quote field ${key}`)
      quote[key] = BigInt(quote[key] as string)
    }
    return record
  }
  const encode = (record: BuyerSwapRecord): string => JSON.stringify(record, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  return {
    async list() { return fs.readdirSync(paths.swapsDir).filter((x) => x.endsWith('.json')).map((x) => decode(secureFileText(join(paths.swapsDir, x)))) },
    async get(id) { const path = file(id); return fs.existsSync(path) ? decode(secureFileText(path)) : undefined },
    async put(record) {
      const path = file(record.swapId)
      record.schemaVersion = 2
      writeSettlementRecordAtomically(path, encode(record), 0o600)
    },
  }
}
