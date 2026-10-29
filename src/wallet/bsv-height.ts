export type BsvHeightPurpose = 'risk' | 'recovery' | 'finality'
export interface BsvHeightSource {
  currentHeight(): Promise<number>
}

export interface BsvHeightReader {
  readBsvHeight(purpose: BsvHeightPurpose): Promise<number>
}

export interface BsvHeightReaderDeps {
  env?: Record<string, string | undefined>
  log?: (message: string) => void
  now?: () => number
}

const ALERT_INTERVAL_MS = 10 * 60_000

export function resolveBsvHeightMaxSkew(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BSV_HEIGHT_MAX_SKEW_BLOCKS ?? '3'
  if (!/^[0-9]+$/.test(raw)) throw new Error(`BSV_HEIGHT_MAX_SKEW_BLOCKS must be an integer in [1,20] (got '${raw}')`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error(`BSV_HEIGHT_MAX_SKEW_BLOCKS must be an integer in [1,20] (got '${raw}')`)
  }
  return value
}

function singleSourceAllowed(env: Record<string, string | undefined>): boolean {
  const raw = env.BSV_HEIGHT_SINGLE_SOURCE_OK
  if (raw === undefined || raw === '0') return false
  if (raw === '1') return true
  throw new Error(`BSV_HEIGHT_SINGLE_SOURCE_OK must be exactly '0' or '1' (got '${raw}')`)
}

/**
 * Validate the operational configuration at construction, rather than after a
 * lock has been funded.  A deliberately explicit override remains available
 * for isolated drills, and is logged loudly so it cannot be mistaken for the
 * normal production posture.
 */
export function makeBsvHeightReader(sources: BsvHeightSource[], deps: BsvHeightReaderDeps = {}): BsvHeightReader {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('BSV height reader requires at least one configured source')
  const env = deps.env ?? process.env
  const maxSkew = resolveBsvHeightMaxSkew(env)
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const allowSingle = singleSourceAllowed(env)
  if (sources.length < 2 && !allowSingle) {
    throw new Error('BSV height risk reads require at least two independent sources; configure Anvil and WhatsOnChain, or set BSV_HEIGHT_SINGLE_SOURCE_OK=1 only to start an attended recovery-only degraded run (new risk still requires two sources; finality stays at zero confirmations)')
  }
  if (sources.length < 2) log('DANGER: BSV_HEIGHT_SINGLE_SOURCE_OK=1 permits startup for recovery reads only; new risk still requires two sources and finality stays at zero confirmations')

  let lastAlertAt = Number.NEGATIVE_INFINITY
  const alert = (message: string): void => {
    if (now() - lastAlertAt >= ALERT_INTERVAL_MS) {
      lastAlertAt = now()
      log(`ALERT: ${message}`)
    }
  }

  return {
    readBsvHeight: async (purpose: BsvHeightPurpose): Promise<number> => {
      const settled = await Promise.allSettled(sources.map((source) => source.currentHeight()))
      const heights = settled
        .filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled' && Number.isSafeInteger(result.value) && result.value > 0)
        .map((result) => result.value)
      if (purpose === 'recovery') {
        if (heights.length === 0) throw new Error('BSV recovery height: no source returned a valid height')
        return Math.max(...heights)
      }
      if (purpose === 'finality') {
        // Height zero is not a valid BSV tip. It is the intentional sentinel
        // for "not final yet": a finality caller must keep waiting rather than
        // let one surviving (possibly ahead) source terminalise a recovery.
        return heights.length >= 2 ? Math.min(...heights) : 0
      }
      if (heights.length < 2) {
        const message = `BSV risk height: only ${heights.length}/2 independent source(s) returned a valid height; refusing new risk`
        alert(message)
        throw new Error(message)
      }
      const maximum = Math.max(...heights)
      const minimum = Math.min(...heights)
      if (maximum - minimum > maxSkew) {
        const message = `BSV risk height: independent sources differ by ${maximum - minimum} blocks (maximum ${maxSkew}); refusing new risk`
        alert(message)
        throw new Error(message)
      }
      return maximum
    },
  }
}
