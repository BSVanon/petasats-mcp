#!/usr/bin/env node
/** PetaSats buyer-kit MCP entrypoint. Stdio stays available even before setup is complete. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { existsSync, realpathSync } from 'fs'
import { fileURLToPath } from 'url'
import { type BuyerHome, type BuyerKit, buyerAddresses, buyerHome, DOOR_IDENTITY_PLACEHOLDER, createBuyerRuntime, initialiseBuyerHome, listBuyerWithdrawalIntents, makeFileBuyerStore, readBuyerConfig, readBuyerKeys, readBuyerLimits, resolveBuyerWithdrawalIntent, resumeSpending } from 'petasats/sdk'
import { createPetaSatsMcpServer, handleToolCall, TOOLS } from './server.js'
import { supportedPairs, parseAsset } from './assets.js'

const terminal = new Set(['delivered', 'refunded', 'failed'])

function unavailableKit(message: string): BuyerKit {
  const unavailable = async (): Promise<never> => { throw new Error(message) }
  return { quote: unavailable, convert: unavailable, startSwap: unavailable, status: unavailable, recover: unavailable, withdrawBsv: unavailable, withdrawBase: unavailable, walletInfo: unavailable }
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}/g, '[redacted credential]')
    .replace(/0x[0-9a-fA-F]{64}/g, '[redacted secret]')
    .replace(/keys\.json/gi, '[redacted credential source]')
    .replace(/\b(?:private\s+key|wif|keys?\s+file)\b/gi, '[redacted credential]')
}

/** Start recovery without awaiting it; one slow rail must never stall the MCP transport. */
export function startBackgroundRecovery(kit: BuyerKit, intervalMs = 60_000, log: (message: string) => void = (message) => console.error(`[petasats-mcp] ${message}`)): () => void {
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    void kit.recover().catch((error) => log(`background recovery failed: ${safeMessage(error)}`)).finally(() => { running = false })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

function actionable(rows: Awaited<ReturnType<BuyerKit['status']>>): boolean {
  return rows.some((row) => !terminal.has(row.stage) && !(row.stage === 'settled' && !row.deliverTo))
}

async function smoke(): Promise<void> {
  const unavailable = unavailableKit('buyer home is not initialised; run `petasats-mcp init` first')
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  checks.push({ name: 'tools_registered', ok: TOOLS.length === 10, detail: `${TOOLS.length} tools` })
  checks.push({ name: 'supported_pairs', ok: supportedPairs().length === 1, detail: 'one phase-1 pair' })
  let parseOk = false
  try { parseAsset('USDC'); parseAsset('BSV'); parseAsset(`bsv21:${'a'.repeat(64)}_0`); try { parseAsset('NOPE') } catch { parseOk = true } } catch { /* failed */ }
  checks.push({ name: 'asset_parse', ok: parseOk, detail: 'known assets parse; junk rejects' })
  checks.push({ name: 'server_build', ok: !!createPetaSatsMcpServer({ petasats: unavailable }), detail: 'server builds without a home' })
  const list = await handleToolCall(unavailable, 'list_liquidity', {})
  checks.push({ name: 'list_liquidity', ok: !list.isError && list.content[0].text.includes('non_custodial'), detail: 'read-only discovery works' })
  const blocked = await handleToolCall(unavailable, 'wallet_info', {})
  checks.push({ name: 'unconfigured_money_tool', ok: blocked.isError === true && blocked.content[0].text.includes('not initialised'), detail: 'money tools fail clearly' })
  for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`)
  const passed = checks.filter((check) => check.ok).length
  console.log(`\n[smoke] ${passed}/${checks.length} checks passed.`)
  process.exitCode = passed === checks.length ? 0 : 1
}

async function recoverUntilQuiet(kit: BuyerKit, timeoutMs: number): Promise<{ actionable: string[]; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs
  let rows = await kit.recover()
  while (actionable(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    rows = await kit.recover()
  }
  return { actionable: rows.filter((row) => !terminal.has(row.stage) && !(row.stage === 'settled' && !row.deliverTo)).map((row) => row.swapId), timedOut: actionable(rows) }
}

function timeoutArg(args: string[]): number {
  const arg = args.find((value) => value.startsWith('--timeout-ms='))
  const value = arg ? Number(arg.slice('--timeout-ms='.length)) : 60_000
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) throw new Error('--timeout-ms must be an integer between 1 and 3600000')
  return value
}

/** Public-only setup result. Keep this small: CLI output must never expose local keys. */
export function initResult(home: BuyerHome): Record<string, unknown> {
  const addresses = buyerAddresses(readBuyerKeys(home))
  const configured = readBuyerConfig(home).doorIdentity !== DOOR_IDENTITY_PLACEHOLDER
  return {
    ok: true,
    home: home.home,
    base_address: addresses.baseAddress,
    bsv_address: addresses.bsvAddress,
    // Absolute paths: desktop AI apps often start servers without the shell's PATH.
    mcp: { command: process.execPath, args: [fileURLToPath(import.meta.url)] },
    next: configured
      ? 'fund the Base address with USDC plus a little ETH for gas, then connect your AI app'
      : 'set config.json doorIdentity before using money tools',
  }
}

/** CLI text is factored for tests; these commands never need a live rail. */
export async function statusOutput(home = buyerHome()): Promise<string> {
  const rows = await makeFileBuyerStore(home).list()
  return JSON.stringify({ swaps: rows.map((row) => ({ swap_id: row.swapId, stage: row.stage, base_lock: row.baseLockTxid, bsv_claim: row.bsvClaimTxid, reason: row.reason })) }, null, 2)
}
export function resumeOutput(home = buyerHome()): string {
  const stop = resumeSpending(home)
  if (!stop) return 'not stopped'
  if (stop.invalid) return 'removed invalid STOP; spending resumed'
  return `${JSON.stringify(stop, null, 2)}\nOK`
}
export function limitsOutput(home = buyerHome()): string {
  try {
    const limits = readBuyerLimits(home)
    return limits ? JSON.stringify(limits, null, 2) : 'none'
  } catch (error) {
    return safeMessage(error)
      .replace(/^refused by your limits file: /, '')
      .replace(/; fix limits\.json at the terminal; nothing was sent$/, '')
  }
}
/** Pending withdrawal records only; signed bytes and all key material stay local. */
export function withdrawalsOutput(home = buyerHome()): string {
  return JSON.stringify({ withdrawals: listBuyerWithdrawalIntents(home)
    .filter((record) => record.state !== 'done')
    .map((record) => ({ hash: record.hash, asset: record.asset, amount: record.amount, destination: record.to, state: record.nonceConsumedAtBlock === undefined ? 'pending' : 'nonce-consumed-requires-user-outcome' })) }, null, 2)
}
export async function withdrawalOutput(hash: string, outcome: string, home = buyerHome()): Promise<string> {
  if (outcome !== 'sent' && outcome !== 'not-sent') throw new Error('usage: npx petasats-mcp withdrawal <hash> sent|not-sent')
  const record = await resolveBuyerWithdrawalIntent(home, hash, outcome)
  return JSON.stringify({ hash: record.hash, asset: record.asset, amount: record.amount, destination: record.to, state: record.state, outcome: record.status }, null, 2)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (process.argv.includes('--smoke')) return smoke()
  if (command === 'init') {
    const home = initialiseBuyerHome()
    console.log(JSON.stringify(initResult(home)))
    return
  }
  if (command === 'status') {
    console.log(await statusOutput())
    return
  }
  if (command === 'resume') {
    console.log(resumeOutput())
    return
  }
  if (command === 'limits') {
    console.log(limitsOutput())
    return
  }
  if (command === 'withdrawals') {
    console.log(withdrawalsOutput())
    return
  }
  if (command === 'withdrawal') {
    console.log(await withdrawalOutput(process.argv[3] ?? '', process.argv[4] ?? ''))
    return
  }
  let runtime: Awaited<ReturnType<typeof createBuyerRuntime>> | undefined
  let unavailable: string | undefined
  const defaultHome = buyerHome()
  const newWallet = !existsSync(defaultHome.home)
  if (newWallet) {
    initialiseBuyerHome(defaultHome.home)
    console.error(`[petasats-mcp] created new buyer home at ${defaultHome.home}`)
  }
  try { runtime = await createBuyerRuntime({ newWallet }) } catch (error) { unavailable = safeMessage(error) }
  if (command === 'recover') {
    if (!runtime) throw new Error(unavailable)
    const result = await recoverUntilQuiet(runtime.kit, timeoutArg(process.argv.slice(3)))
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.timedOut ? 2 : 0
    return
  }
  const kit = runtime?.kit ?? unavailableKit(unavailable ?? 'buyer runtime is unavailable')
  const server = createPetaSatsMcpServer({ petasats: kit, doorIdentity: runtime?.config.doorIdentity })
  startBackgroundRecovery(kit)
  await server.connect(new StdioServerTransport())
  console.error(runtime ? '[petasats-mcp] running on stdio' : `[petasats-mcp] running on stdio; money tools unavailable: ${unavailable}`)
}

/** npm installs the bin as a symlink (POSIX) while import.meta.url is the real path; compare real paths. */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl)) } catch { return false }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void main().catch((error) => {
    console.error(`[petasats-mcp] Fatal: ${safeMessage(error)}`)
    process.exitCode = 1
  })
}
