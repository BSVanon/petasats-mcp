import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { resolveMakerSignerStatePath } from './signer-state-path'
export const DEFAULT_EVM_SEND_LOCK_TIMEOUT_MS = 30_000
export const DEFAULT_FLOCK_BIN = '/usr/bin/flock'
export interface EvmSendLock {
  readonly path: string
  runExclusive<T>(criticalSection: () => Promise<T>): Promise<T>
}

export interface EvmSendLockLease {
  release(): Promise<void>
}

export interface KernelFlockEvmSendLockOpts {
  acquireTimeoutMs?: number
  flockBin?: string
}

export function resolveMakerEvmSendLockPath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const raw = env.MAKER_EVM_SEND_LOCK?.trim() || join(resolveMakerSignerStatePath(env, cwd), 'evm-send.lock')
  if (raw.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    throw new Error(`MAKER_EVM_SEND_LOCK must be a local filesystem path shared by the signer and watchtower daemon (got '${raw}')`)
  }
  return resolve(cwd, raw)
}

function assertPositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`EVM send lock acquireTimeoutMs must be a positive safe integer (got ${String(value)})`)
  }
}

async function openSharedLockFile(path: string): Promise<FileHandle> {
  const parent = dirname(path)
  const created = await mkdir(parent, { recursive: true, mode: 0o770 })
  // mkdir's mode is umask-filtered. Force only a newly-created coordination directory; never strip an existing
  // deployment's setgid bit (normally 02770) or otherwise rewrite operator-managed permissions.
  if (created !== undefined) await chmod(parent, 0o770)

  let handle: FileHandle
  try {
    // O_EXCL lets the creator set stable group-readable permissions before any later acquisition uses the inode.
    handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW, 0o660)
    try {
      await handle.chmod(0o660)
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  }

  const opened = await handle.stat()
  if (!opened.isFile()) {
    await handle.close()
    throw new Error(`EVM send lock ${path} must be a regular file (refusing a directory/device lock target)`)
  }
  return handle
}

/**
 * A Linux kernel flock lease. Separate opens create separate open-file descriptions, so two concurrent sends in the
 * SAME Node process contend and queue exactly like sends from different processes (no PID/self-reclaim shortcut).
 */
export class KernelFlockEvmSendLock implements EvmSendLock {
  readonly path: string
  private readonly acquireTimeoutMs: number
  private readonly flockBin: string

  constructor(path: string, opts: KernelFlockEvmSendLockOpts = {}) {
    this.path = resolve(path)
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_EVM_SEND_LOCK_TIMEOUT_MS
    this.flockBin = opts.flockBin ?? DEFAULT_FLOCK_BIN
    assertPositiveTimeout(this.acquireTimeoutMs)
  }

  private async closeLeaseHandle(handle: FileHandle): Promise<void> {
    try {
      await handle.close() // kernel releases flock when this final open-file-description reference closes
    } catch (error) {
      // A send may already be broadcast. Never convert that success into a retry-inducing error because cleanup failed.
      console.error(`EVM send lock release failed for ${this.path}; kernel will release the flock when this process exits: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async acquire(): Promise<EvmSendLockLease> {
    const handle = await openSharedLockFile(this.path)
    const timeoutSeconds = (this.acquireTimeoutMs / 1_000).toFixed(3)

    try {
      await new Promise<void>((resolveAcquired, reject) => {
        let stderr = ''
        let settled = false
        // fd 3 is a dup of `handle.fd`, hence the SAME Linux open-file description. `flock` applies the kernel lock
        // and exits; our retained FileHandle continues to own it until release() or process death.
        const child = spawn(this.flockBin, [
          '--exclusive', '--timeout', timeoutSeconds, '--conflict-exit-code', '75', '3',
        ], { stdio: ['ignore', 'ignore', 'pipe', handle.fd] })
        child.stderr!.setEncoding('utf8')
        child.stderr!.on('data', (chunk: string) => { stderr += chunk })
        child.once('error', (error) => {
          if (settled) return
          settled = true
          reject(new Error(`EVM send lock cannot execute ${this.flockBin}: ${error.message}`))
        })
        child.once('close', (code, signal) => {
          if (settled) return
          settled = true
          if (code === 0) {
            resolveAcquired()
            return
          }
          if (code === 75) {
            reject(new Error(`EVM send lock timed out after ${this.acquireTimeoutMs}ms waiting for ${this.path} (fail-closed; transaction not prepared or broadcast)`))
            return
          }
          reject(new Error(
            `EVM send lock acquisition failed for ${this.path}: flock exited ${code ?? `by signal ${signal ?? 'unknown'}`}` +
            `${stderr.trim() ? ` (${stderr.trim()})` : ''}`,
          ))
        })
      })

      // A group-writable coordination directory permits pathname replacement. Advisory locking assumes cooperative
      // peers, but still fail closed if replacement happened during acquisition rather than silently locking an orphan.
      const named = await lstat(this.path)
      const opened = await handle.stat()
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
        throw new Error(`EVM send lock pathname ${this.path} changed during acquisition — refusing to send on an orphaned inode`)
      }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }

    let released = false
    return {
      release: async (): Promise<void> => {
        if (released) return
        released = true
        await this.closeLeaseHandle(handle)
      },
    }
  }

  async runExclusive<T>(criticalSection: () => Promise<T>): Promise<T> {
    const lease = await this.acquire()
    try {
      return await criticalSection()
    } finally {
      await lease.release()
    }
  }

  /** Boot probe: proves the binary, directory, permissions, inode identity, acquisition, and release all work. */
  async assertReady(): Promise<void> {
    await this.runExclusive(async () => {})
  }
}
