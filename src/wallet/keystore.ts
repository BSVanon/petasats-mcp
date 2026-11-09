import { PrivateKey, SymmetricKey } from '@bsv/sdk'
import { scryptSync, randomBytes } from 'crypto'
import { writeFileSync, readFileSync, chmodSync, lstatSync } from 'fs'
export class KeystoreError extends Error {
  constructor(message: string) {
    super(`keystore: ${message}`)
    this.name = 'KeystoreError'
  }
}
export interface ScryptParams {
  N: number // CPU/memory cost, power of two
  r: number // block size
  p: number // parallelization
}
/** Strong single-factor default: N=2^15 (~32 MiB · 128·N·r), r=8, p=1. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 32768, r: 8, p: 1 }
/**
 * Production policy bounds, enforced at seal AND open. Rejects weak params
 * (cheap offline brute-force) and oversized params (a tampered keystore causing
 * a CPU/memory DoS before decryption). The memory bound (128·N·r) applies even
 * under the test override, so nothing can request a runaway allocation.
 */
export const SCRYPT_POLICY = {
  minN: 1 << 14, // 16384
  maxN: 1 << 17, // 131072
  minR: 8,
  maxR: 16,
  minP: 1,
  maxP: 4,
  maxMemBytes: 256 * 1024 * 1024 // caps 128·N·r
} as const

const SCRYPT_MAXMEM = 512 * 1024 * 1024 // scrypt's own guard, generous headroom over the policy cap

export interface OpenOpts {
  /** TEST ONLY — bypasses the SCRYPT_POLICY min/max bounds. Never set on a real mainnet keystore. */
  allowInsecureParams?: boolean
}

export interface KeystoreFile {
  v: 1
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string // hex
  ciphertext: string // hex — SymmetricKey output |IV|ciphertext|authTag|
}

const SALT_LEN = 16
const KEY_LEN = 32

function assertScryptPolicy(p: ScryptParams, allowInsecure: boolean): void {
  if (!isPow2(p.N) || p.N < 2) throw new KeystoreError('scrypt N must be a power of two ≥ 2')
  if (!Number.isInteger(p.r) || p.r < 1 || !Number.isInteger(p.p) || p.p < 1) throw new KeystoreError('scrypt r,p must be positive integers')
  // Memory backstop ALWAYS applies — even a test override cannot request a DoS-sized allocation.
  const mem = 128 * p.N * p.r
  if (mem > SCRYPT_POLICY.maxMemBytes) throw new KeystoreError(`scrypt params exceed the memory bound (128·N·r=${mem} > ${SCRYPT_POLICY.maxMemBytes})`)
  if (allowInsecure) return
  const P = SCRYPT_POLICY
  if (p.N < P.minN || p.N > P.maxN) throw new KeystoreError(`scrypt N=${p.N} outside production policy [${P.minN}, ${P.maxN}]`)
  if (p.r < P.minR || p.r > P.maxR) throw new KeystoreError(`scrypt r=${p.r} outside production policy [${P.minR}, ${P.maxR}]`)
  if (p.p < P.minP || p.p > P.maxP) throw new KeystoreError(`scrypt p=${p.p} outside production policy [${P.minP}, ${P.maxP}]`)
}

function deriveKey(passphrase: string, salt: Uint8Array, p: ScryptParams, allowInsecure: boolean): SymmetricKey {
  assertScryptPolicy(p, allowInsecure)
  const key = scryptSync(passphrase, Buffer.from(salt), KEY_LEN, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT_MAXMEM })
  return new SymmetricKey(Array.from(key))
}

/** Encrypt a WIF under a passphrase. Validates the WIF and scrypt policy before sealing (fail fast). */
export function sealWif(wif: string, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT, opts: OpenOpts = {}): KeystoreFile {
  assertValidWif(wif)
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new KeystoreError('passphrase must be a non-empty string')
  const salt = randomBytes(SALT_LEN)
  const sk = deriveKey(passphrase, salt, params, opts.allowInsecureParams === true)
  const ciphertext = sk.encrypt(wif) as number[]
  return { v: 1, kdf: 'scrypt', N: params.N, r: params.r, p: params.p, salt: hex(salt), ciphertext: hex(ciphertext) }
}

/** Decrypt the WIF. Throws `KeystoreError` on out-of-policy params, a wrong passphrase, or tampering. */
export function openWif(file: KeystoreFile, passphrase: string, opts: OpenOpts = {}): string {
  assertFile(file)
  // Policy is checked BEFORE scrypt runs, so a tampered file cannot trigger a DoS-sized derivation.
  const sk = deriveKey(passphrase, unhex(file.salt), { N: file.N, r: file.r, p: file.p }, opts.allowInsecureParams === true)
  let wif: string
  try {
    wif = sk.decrypt(unhexArr(file.ciphertext), 'utf8') as string
  } catch {
    // AES-GCM auth-tag mismatch: wrong passphrase or corrupted ciphertext/salt.
    throw new KeystoreError('decryption failed — wrong passphrase or corrupted keystore')
  }
  assertValidWif(wif) // defense-in-depth: the decrypted plaintext must be a real WIF
  return wif
}

export function sealSecret(plaintext: string, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT, opts: OpenOpts = {}): KeystoreFile {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new KeystoreError('plaintext must be a non-empty string')
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new KeystoreError('passphrase must be a non-empty string')
  const salt = randomBytes(SALT_LEN)
  const sk = deriveKey(passphrase, salt, params, opts.allowInsecureParams === true)
  const ciphertext = sk.encrypt(plaintext) as number[]
  return { v: 1, kdf: 'scrypt', N: params.N, r: params.r, p: params.p, salt: hex(salt), ciphertext: hex(ciphertext) }
}

/** Decrypt a secret sealed by `sealSecret`. Throws `KeystoreError` on a wrong passphrase or tampering. */
export function openSecret(file: KeystoreFile, passphrase: string, opts: OpenOpts = {}): string {
  assertFile(file)
  const sk = deriveKey(passphrase, unhex(file.salt), { N: file.N, r: file.r, p: file.p }, opts.allowInsecureParams === true)
  try {
    return sk.decrypt(unhexArr(file.ciphertext), 'utf8') as string
  } catch {
    throw new KeystoreError('decryption failed — wrong passphrase or corrupted keystore')
  }
}

/** Convenience: decrypt straight to a `PrivateKey`. */
export function toPrivateKey(file: KeystoreFile, passphrase: string, opts: OpenOpts = {}): PrivateKey {
  return PrivateKey.fromWif(openWif(file, passphrase, opts))
}
// ─────────────────────────── thin fs helpers (0600) ───────────────────────────
/** Persist a keystore file with owner-only (0600) permissions; refuses to write through a symlink. */
export function writeKeystoreFile(path: string, file: KeystoreFile): void {
  assertFile(file)
  refuseSymlink(path)
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600) // enforce even if the file pre-existed with looser perms
}

/** Read a keystore, refusing symlinks, non-regular files, and group/world-readable modes. */
export function readKeystoreFile(path: string): KeystoreFile {
  assertReadableSecurely(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new KeystoreError(`cannot read/parse keystore at ${path}`)
  }
  return assertFile(parsed)
}

// ─────────────────────────── validation ───────────────────────────

function assertValidWif(wif: string): void {
  try {
    PrivateKey.fromWif(wif)
  } catch {
    throw new KeystoreError('not a valid WIF private key')
  }
}

function assertFile(f: unknown): KeystoreFile {
  const o = f as Record<string, unknown>
  if (o === null || typeof o !== 'object') throw new KeystoreError('keystore is not an object')
  if (o.v !== 1) throw new KeystoreError(`unsupported keystore version ${String(o.v)}`)
  if (o.kdf !== 'scrypt') throw new KeystoreError(`unsupported kdf ${String(o.kdf)}`)
  for (const k of ['N', 'r', 'p'] as const) {
    if (!Number.isInteger(o[k])) throw new KeystoreError(`keystore field "${k}" must be an integer`)
  }
  for (const k of ['salt', 'ciphertext'] as const) {
    if (typeof o[k] !== 'string' || !/^[0-9a-f]*$/i.test(o[k] as string) || (o[k] as string).length % 2 !== 0) {
      throw new KeystoreError(`keystore field "${k}" must be a hex string`)
    }
  }
  return o as unknown as KeystoreFile
}

function assertReadableSecurely(path: string): void {
  let ls
  try {
    ls = lstatSync(path)
  } catch {
    throw new KeystoreError(`cannot stat keystore at ${path}`)
  }
  if (ls.isSymbolicLink()) throw new KeystoreError('keystore path is a symlink — refusing to follow')
  if (!ls.isFile()) throw new KeystoreError('keystore path is not a regular file')
  // POSIX: refuse group/world-accessible key material (skip on win32 where these bits are meaningless).
  if (process.platform !== 'win32' && (ls.mode & 0o077) !== 0) {
    throw new KeystoreError(`keystore has loose permissions 0${(ls.mode & 0o777).toString(8)} — must be 0600 (owner-only)`)
  }
}

function refuseSymlink(path: string): void {
  let ls
  try {
    ls = lstatSync(path)
  } catch {
    return // ENOENT etc. — writing a brand-new file is fine
  }
  if (ls.isSymbolicLink()) throw new KeystoreError('refusing to write a keystore through a symlink')
}

// ─────────────────────────── helpers ───────────────────────────

function isPow2(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
}

function hex(b: Uint8Array | number[]): string {
  return Buffer.from(b).toString('hex')
}

function unhex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h, 'hex'))
}

function unhexArr(h: string): number[] {
  return Array.from(Buffer.from(h, 'hex'))
}
