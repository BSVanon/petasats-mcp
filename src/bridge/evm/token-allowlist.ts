/**
 * ERC20 token allowlist for the bridge — the money guard that makes "one contract, N tokens" SAFE.
 *
 * The Boltz ERC20Swap contract is token-agnostic, so the ONLY thing standing between "swap USDC" and
 * "swap an arbitrary/hostile ERC20" is this list. Two failure modes it closes:
 *   1. HTLC ACCOUNTING BREAK — a fee-on-transfer or rebasing token makes the contract receive/hold a
 *      DIFFERENT amount than was locked, so the claim (which expects `amount`) fails or under/over-pays.
 *      Only `transfer: 'standard'` tokens are listed, and resolveAllowedToken re-asserts it.
 *   2. DECIMALS MISREAD — a wrong `decimals` misprices a swap by 10^n. Decimals are VERIFIED on-chain
 *      and HARDCODED here; a runtime fetch is NOT trusted (a transient empty eth_call reads as 0, caught
 *      2026-08-19). assertDecimalsMatch cross-checks a live reading fail-closed.
 *
 * Every address below was verified on Base mainnet (symbol + decimals) 2026-08-19. To add a token:
 * verify symbol+decimals on-chain, confirm it is NOT fee-on-transfer / rebasing, then add it here —
 * never resolve a token that is not on this list.
 */

export interface AllowedToken {
  symbol: string
  /** Checksummed contract address; compared case-insensitively. */
  address: `0x${string}`
  /** VERIFIED on-chain, hardcoded — never a runtime default. */
  decimals: number
  chainId: number
  /** 'standard' = no fee-on-transfer, no rebalance/rebasing (HTLC-amount-safe). Only 'standard' is listed. */
  transfer: 'standard'
  /** Can the issuer pause/blocklist? (informational — a policy/cap layer may weight this; not a swap blocker at de-minimis.) */
  issuerFreeze: boolean
  /** TRUE iff the token trades ~$1 (a USD stablecoin). The bridge derives `amountUsd = quantity / 10^decimals`, which
   *  EQUALS USD only for a $1 peg — so EVERY USD-denominated guard (0-conf cap, Lever-A finality tier, co-sign
   *  threshold, per-swap cap, signing-policy) is only correct for a pegged token. LEVER-B HIGH-1 (red-team 2026-09-04):
   *  the bridge is RESTRICTED to peggedUsd tokens until a real USD price oracle prices non-$1 tokens (see
   *  [[project_petasats_quantity_usd_defect]]). WETH/cbBTC stay listed (transfer-safe) but are NOT bridge-eligible. */
  peggedUsd: boolean
  notes: string
}

const BASE_MAINNET = 8453
const BASE_SEPOLIA = 84532

/** Verified on-chain 2026-08-19. Add only after verifying symbol+decimals AND non-fee-on-transfer/non-rebasing. */
export const TOKEN_ALLOWLIST: AllowedToken[] = [
  // ── Base mainnet ──
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, chainId: BASE_MAINNET, transfer: 'standard', issuerFreeze: true, peggedUsd: true, notes: 'Native Circle USDC. Standard transfer; Circle can freeze addresses (rare, issuer action). Proven live.' },
  { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, chainId: BASE_MAINNET, transfer: 'standard', issuerFreeze: true, peggedUsd: true, notes: 'Tether USD on Base. Standard transfer; Tether can freeze. Largest stablecoin — priority pair.' },
  { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, chainId: BASE_MAINNET, transfer: 'standard', issuerFreeze: false, peggedUsd: true, notes: 'MakerDAO DAI (bridged). Standard transfer; no issuer address-freeze.' },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, chainId: BASE_MAINNET, transfer: 'standard', issuerFreeze: false, peggedUsd: false, notes: 'Canonical OP-stack WETH predeploy. Pure wrapper; no freeze, no fee-on-transfer.' },
  { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, chainId: BASE_MAINNET, transfer: 'standard', issuerFreeze: true, peggedUsd: false, notes: 'Coinbase Wrapped BTC — BTC exposure WITHOUT a native BTC rail. Standard transfer; Coinbase can freeze.' },
  // ── Base Sepolia (testnet) ──
  { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, chainId: BASE_SEPOLIA, transfer: 'standard', issuerFreeze: true, peggedUsd: true, notes: 'Circle test USDC on Base Sepolia. Used for testnet proofs.' },
]

const norm = (a: string): string => a.toLowerCase()
const CANONICAL_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The ONLY sanctioned way to turn a (chainId, address) into swap parameters. Fail-closed: throws if the
 * token is not allowlisted for that chain, or (defensively) if a listed token is not 'standard' transfer.
 * The runner MUST resolve every token through this — an un-vetted token then cannot be swapped.
 */
export function resolveAllowedToken(chainId: number, address: string): AllowedToken {
  // Do not reflect attacker-controlled unbounded input into durable audit/error rows.
  if (!CANONICAL_ADDRESS.test(address)) {
    throw new Error(`token address is non-canonical token address — refusing`)
  }
  const hit = TOKEN_ALLOWLIST.find((t) => t.chainId === chainId && norm(t.address) === norm(address))
  if (!hit) {
    throw new Error(`token ${address} is not allowlisted on chain ${chainId} — refusing (un-vetted ERC20 could be fee-on-transfer/rebasing/mis-decimaled). Verify + add to TOKEN_ALLOWLIST first.`)
  }
  if (hit.transfer !== 'standard') {
    throw new Error(`token ${hit.symbol} (${address}) is not 'standard' transfer — refusing (HTLC amount-accounting guard)`)
  }
  return hit
}

/**
 * Resolve an allowlisted token by (chainId, symbol) — the ONLY sanctioned way to get a swap's decimals from its
 * SYMBOL (a runner knows the asset it quotes, e.g. 'USDC', before it sees a per-swap token address). Fail-closed:
 * throws if no allowlisted 'standard'-transfer token of that symbol exists on that chain, so a receive-decimals
 * config can NEVER diverge from the verified on-chain value (review 999d7a0e HIGH: an operator-set decimals let a
 * taker lock tiny USDC atomic units for full BSV).
 */
export function resolveAllowedTokenBySymbol(chainId: number, symbol: string): AllowedToken {
  const hit = TOKEN_ALLOWLIST.find((t) => t.chainId === chainId && t.symbol === symbol)
  if (!hit) {
    throw new Error(`no allowlisted token '${symbol}' on chain ${chainId} — refusing (decimals must come from the verified allowlist, never operator config).`)
  }
  if (hit.transfer !== 'standard') {
    throw new Error(`token ${hit.symbol} on chain ${chainId} is not 'standard' transfer — refusing (HTLC amount-accounting guard)`)
  }
  return hit
}

/**
 * Fail-closed cross-check of a LIVE on-chain decimals reading against the hardcoded value. Since our
 * verified decimals are 6/8/18 (never 0), a transient empty eth_call (→ 0) or any drift is rejected.
 */
export function assertDecimalsMatch(token: AllowedToken, onchainDecimals: number): void {
  if (!Number.isInteger(onchainDecimals) || onchainDecimals !== token.decimals) {
    throw new Error(`decimals mismatch for ${token.symbol}: hardcoded ${token.decimals}, on-chain ${onchainDecimals} — refusing (mispricing guard; a wrong reading skews value by 10^n)`)
  }
}

/**
 * The single fail-closed token gate the runner MUST call before committing funds (review bc909852):
 * (1) resolveAllowedToken (allowlisted + transfer:'standard'), then (2) cross-check the hardcoded
 * decimals against a LIVE on-chain reading. `readOnchainDecimals` is injected (the EVM client's
 * tokenDecimals in production, a fake in tests) and is expected to THROW on a reverted/empty response —
 * so a wrong/typo'd allowlist entry OR an unreadable contract both fail closed before a lock. Returns
 * the vetted token.
 */
export async function assertTokenAllowedAndDecimals(
  chainId: number,
  address: string,
  readOnchainDecimals: (addr: `0x${string}`) => Promise<number>,
  requirePeggedUsd = false,
): Promise<AllowedToken> {
  const tok = resolveAllowedToken(chainId, address)
  const onchain = await readOnchainDecimals(tok.address)
  assertDecimalsMatch(tok, onchain)
  // LEVER-B HIGH-1 (red-team 2026-09-04): the bridge derives `amountUsd = quantity / 10^decimals`, which equals USD
  // ONLY for a $1 peg — so a non-pegged token (WETH/cbBTC) would read a ~$60k swap as "$1" and silently defeat every
  // USD guard (0-conf cap, finality tier, co-sign threshold, per-swap cap). Refuse it on the bridge until a real USD
  if (requirePeggedUsd && !tok.peggedUsd) {
    throw new Error(`token ${tok.symbol} is not USD-pegged — the bridge prices swaps from token QUANTITY (valid only at $1). Refusing a non-$1 bridge token until a USD price oracle is wired (LEVER-B HIGH-1; project_petasats_quantity_usd_defect).`)
  }
  return tok
}
