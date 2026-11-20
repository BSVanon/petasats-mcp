import { expect } from 'chai'
import { describe, it, beforeEach, afterEach } from 'mocha'
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
  type PathLike,
} from 'fs'
import * as fs from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { assertSecureBuyerHome, buyerAddresses, buyerHome, initialiseBuyerHome, isNewBuyerHome, readBuyerKeys, safeMkdir, secureFileText } from '../../src/sdk/buyer/local-state'

describe('local-state owner-only permission checks relax only on win32 (POSIX stays byte-identical)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'petasats-local-state-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it("secureFileText refuses a loosened 0o644 file on 'linux' but accepts it on 'win32'", () => {
    const path = join(dir, 'secret.json')
    writeFileSync(path, '{"a":1}')
    chmodSync(path, 0o644)
    expect(() => secureFileText(path, 'linux')).to.throw(/unsafe permissions/)
    expect(secureFileText(path, 'win32')).to.equal('{"a":1}')
  })

  it("assertSecureBuyerHome refuses a loosened 0o755 home directory on 'linux' but accepts it on 'win32'", () => {
    const home = initialiseBuyerHome(join(dir, 'home'))
    chmodSync(home.home, 0o755)
    expect(() => assertSecureBuyerHome(home, 'linux')).to.throw(/unsafe local directory/)
    expect(() => assertSecureBuyerHome(home, 'win32')).to.not.throw()
  })
})

describe('buyerHome — the Windows HOME fallback', () => {
  it('falls back to os.homedir(), not the current directory, when HOME and PETASATS_HOME are both unset', () => {
    const savedHome = process.env.HOME
    const savedPetasatsHome = process.env.PETASATS_HOME
    delete process.env.HOME
    delete process.env.PETASATS_HOME
    try {
      expect(buyerHome().home).to.equal(join(homedir(), '.petasats'))
    } finally {
      savedHome === undefined ? delete process.env.HOME : process.env.HOME = savedHome
      savedPetasatsHome === undefined ? delete process.env.PETASATS_HOME : process.env.PETASATS_HOME = savedPetasatsHome
    }
  })
})

describe('safeMkdir — the owner-only directory helper shared by local-state and the buyer-home lock', () => {
  let parent: string
  beforeEach(() => { parent = mkdtempSync(join(tmpdir(), 'petasats-safemkdir-')) })
  afterEach(() => { rmSync(parent, { recursive: true, force: true }) })

  /** Spy every call safeMkdir can make, wrapping through to the real fs so a genuine directory is still created and secured. */
  function spy() {
    const calls: string[] = []
    const fileSystem = {
      lstatSync: (path: PathLike) => { calls.push('lstat'); return lstatSync(path) },
      mkdirSync: (path: PathLike, options: { recursive: true; mode: number }) => { calls.push('mkdir'); return mkdirSync(path, options) },
      openSync: (path: PathLike, flags: string | number) => { calls.push('open'); return openSync(path, flags) },
      fstatSync: (fd: number) => { calls.push('fstat'); return fstatSync(fd) },
      fchmodSync: (fd: number, mode: string | number) => { calls.push('fchmod'); fchmodSync(fd, mode) },
      closeSync: (fd: number) => { calls.push('close'); closeSync(fd) },
      chmodSync: (path: PathLike, mode: string | number) => { calls.push('chmod'); chmodSync(path, mode) },
    }
    // safeMkdir's real parameter type (BuyerHomeFs) is a 13-member Pick<typeof fs, ...> that is not exported; this
    // spy implements only the 7 members safeMkdir actually calls, so it is asserted through the real signature
    // rather than structurally matched.
    return { calls, fileSystem: fileSystem as unknown as Parameters<typeof safeMkdir>[1] }
  }

  it('with the real constants on Linux: lstat, mkdir, lstat, open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW), fstat, fchmod 0700, close', function () {
    if (process.platform === 'win32') { this.skip(); return } // Windows lacks O_DIRECTORY; the injected-constants test below covers that branch
    const path = join(parent, 'd')
    const { calls, fileSystem } = spy()
    safeMkdir(path, fileSystem)
    expect(calls).to.deep.equal(['lstat', 'mkdir', 'lstat', 'open', 'fstat', 'fchmod', 'close'])
    expect(statSync(path).mode & 0o777).to.equal(0o700)
  })

  it('with injected constants lacking O_DIRECTORY (the win32 gap), safeMkdir chmods the path and never opens or fchmods a directory handle', () => {
    const path = join(parent, 'd')
    const { calls, fileSystem } = spy()
    const fsConstants = { ...constants, O_DIRECTORY: undefined } as unknown as Parameters<typeof safeMkdir>[2]
    safeMkdir(path, fileSystem, fsConstants)
    expect(calls).to.deep.equal(['lstat', 'mkdir', 'lstat', 'chmod'])
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).to.equal(0o700) // Windows reports synthesized 0o666 mode bits
  })
})

describe('initialiseBuyerHome — new keys only in a new folder, the same rule everywhere', () => {
  type TreeEntry = { kind: 'file'; content: string } | { kind: 'dir'; mode: number }
  /**
   * Every entry under dir, recursively: a file's byte-identical content, and (M1) a folder's own presence and mode.
   * Recording folders too means a mutation that creates a folder earlier than it should (R1), or that would have
   * created one that was not already there, is visible here even when the function still ultimately refuses.
   */
  function snapshotTree(dir: string): Record<string, TreeEntry> {
    const out: Record<string, TreeEntry> = {}
    const walk = (base: string, prefix: string): void => {
      for (const name of readdirSync(base)) {
        const full = join(base, name)
        const rel = prefix ? `${prefix}/${name}` : name
        const stat = lstatSync(full)
        if (stat.isDirectory()) { out[rel] = { kind: 'dir', mode: stat.mode & 0o777 }; walk(full, rel) }
        else out[rel] = { kind: 'file', content: readFileSync(full, 'utf8') }
      }
    }
    walk(dir, '')
    return out
  }

  const refusalText = (home: string): string =>
    `${home} holds kit files but no keys.json, so no new keys were created. Restore keys.json from your backup, or use a new, empty folder for a new kit.`

  /**
   * The kit's 3 subfolders only, built from nothing with plain mkdirSync — not secured to 0700 the way safeMkdir
   * would (M1). A NOT_NEW case then holds only its one named entry plus this baseline, no config.json and no prior
   * init, so the named entry alone is what disqualifies it. The plain (non-0700) mode also means a mutation that
   * runs safeMkdir before the not-new check (R1) is caught by the mode it would "fix" in the snapshot above, even
   * though every one of these folders already existed and the function still ultimately refuses.
   */
  function buildEmptyKitSubfolders(home: string): ReturnType<typeof buyerHome> {
    const paths = buyerHome(home)
    mkdirSync(paths.swapsDir, { recursive: true }); mkdirSync(paths.settlementDir); mkdirSync(paths.withdrawalsDir)
    return paths
  }

  const NOT_NEW: Array<[string, (home: ReturnType<typeof buyerHome>) => void]> = [
    ['swaps/x.json', (home) => writeFileSync(join(home.swapsDir, 'x.json'), '{}')],
    ['withdrawals/x.json', (home) => writeFileSync(join(home.withdrawalsDir, 'x.json'), '{}')],
    ['settlement/x.json', (home) => writeFileSync(join(home.settlementDir, 'x.json'), '{}')],
    ['STOP', (home) => writeFileSync(home.stopPath, '{"at":1}')],
    ['close.json', (home) => writeFileSync(join(home.home, 'close.json'), '{}')],
    ['limits.json', (home) => writeFileSync(home.limitsPath, '{"format":"petasats.limits/1"}')],
    ['config.json', (home) => writeFileSync(home.configPath, '{}')],
    ['an unknown file', (home) => writeFileSync(join(home.home, 'mystery.unknown'), 'x')],
  ]

  for (const [label, addEntry] of NOT_NEW) {
    it(`refuses new keys for ${label}: no keys.json, nothing created or changed`, () => {
      const parent = mkdtempSync(join(tmpdir(), 'petasats-not-new-'))
      const home = buildEmptyKitSubfolders(join(parent, 'home'))
      addEntry(home)
      expect(isNewBuyerHome(home.home), label).to.equal(false)
      const before = snapshotTree(home.home)
      expect(() => initialiseBuyerHome(home.home)).to.throw(refusalText(home.home))
      expect(existsSync(home.keysPath), label).to.equal(false)
      expect(snapshotTree(home.home), label).to.deep.equal(before)
    })
  }

  const NEW_GETS_KEYS: Array<[string, (parent: string) => string]> = [
    ['a missing folder', (parent) => join(parent, 'missing')],
    ['an empty folder', (parent) => { const dir = join(parent, 'empty'); mkdirSync(dir); return dir }],
    ['.DS_Store only', (parent) => { const dir = join(parent, 'dsstore'); mkdirSync(dir); writeFileSync(join(dir, '.DS_Store'), ''); return dir }],
    ['empty kit subfolders (swaps, settlement, withdrawals, all three)', (parent) => {
      const dir = join(parent, 'subfolders')
      mkdirSync(join(dir, 'swaps'), { recursive: true }); mkdirSync(join(dir, 'settlement')); mkdirSync(join(dir, 'withdrawals'))
      return dir
    }],
    ['a .DS_Store file inside a kit subfolder (n5)', (parent) => {
      const dir = join(parent, 'subfolder-dsstore')
      mkdirSync(join(dir, 'swaps'), { recursive: true }); mkdirSync(join(dir, 'settlement')); mkdirSync(join(dir, 'withdrawals'))
      writeFileSync(join(dir, 'swaps', '.DS_Store'), '')
      return dir
    }],
  ]

  for (const [label, makeDir] of NEW_GETS_KEYS) {
    it(`treats ${label} as new and creates keys.json with mode 600`, () => {
      const parent = mkdtempSync(join(tmpdir(), 'petasats-is-new-'))
      const dir = makeDir(parent)
      expect(isNewBuyerHome(dir), label).to.equal(true)
      const home = initialiseBuyerHome(dir)
      expect(existsSync(home.keysPath), label).to.equal(true)
      if (process.platform !== 'win32') expect(statSync(home.keysPath).mode & 0o777, label).to.equal(0o600)
    })
  }

  it('a bare limits.json alone, with no prior init, disqualifies on its own: not merely alongside config.json', () => {
    // The parametrized limits.json case above always runs after a full init, so config.json is already present and
    // would disqualify the folder by itself either way. This isolates limits.json as the ONLY entry, so a mutation
    // that wrongly treats limits.json as harmless (the way .DS_Store is) flips this case to new and is caught here.
    const dir = mkdtempSync(join(tmpdir(), 'petasats-limits-only-'))
    writeFileSync(join(dir, 'limits.json'), '{"format":"petasats.limits/1"}')
    expect(isNewBuyerHome(dir)).to.equal(false)
    const before = snapshotTree(dir)
    expect(() => initialiseBuyerHome(dir)).to.throw(refusalText(dir))
    expect(existsSync(join(dir, 'keys.json'))).to.equal(false)
    expect(snapshotTree(dir)).to.deep.equal(before)
  })

  it('n2 a same-named directory for .DS_Store (not a regular file) disqualifies the folder, even holding real content', () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-ds-store-dir-'))
    const home = buildEmptyKitSubfolders(join(parent, 'home'))
    mkdirSync(join(home.home, '.DS_Store')) // a directory, not a file, named .DS_Store, holding a real record
    writeFileSync(join(home.home, '.DS_Store', 'real.json'), '{}')
    expect(isNewBuyerHome(home.home)).to.equal(false)
    expect(() => initialiseBuyerHome(home.home)).to.throw(refusalText(home.home))
    expect(existsSync(home.keysPath)).to.equal(false)
  })

  it('n3 a PETASATS_HOME that is a regular file keeps its old "unsafe local directory" refusal, not the holds-kit-files text', () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-home-is-file-'))
    const file = join(parent, 'home')
    writeFileSync(file, 'not a directory')
    expect(() => initialiseBuyerHome(file)).to.throw(/unsafe local directory/)
  })

  // n4: two first starts at once. The injected BuyerHomeFs is the real fs with one call wrapped, so the other start's
  // keys.json can be written at the exact moment under test.
  type HomeFs = Parameters<typeof initialiseBuyerHome>[1]
  /** A complete, valid keys.json: the other first start's, made by a real first start in a scratch folder. */
  const otherStartKeys = (parent: string): string => readFileSync(initialiseBuyerHome(join(parent, 'other-start')).keysPath, 'utf8')

  it("n4 keys.json written by another first start while this one reads the folder: no refusal, and the other start's keys are used", () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-race-readdir-'))
    const home = buildEmptyKitSubfolders(join(parent, 'home'))
    const keys = otherStartKeys(parent)
    let listed: string[] | undefined
    const fileSystem = { ...fs, readdirSync: (path: PathLike, ...rest: unknown[]) => {
      const first = path === home.home && listed === undefined
      if (first) writeFileSync(home.keysPath, keys, { mode: 0o600 }) // the other start writes keys.json during this read
      const entries = (fs.readdirSync as (...args: unknown[]) => string[])(path, ...rest)
      if (first) listed = entries
      return entries
    } } as unknown as HomeFs
    expect(() => initialiseBuyerHome(home.home, fileSystem)).not.to.throw()
    expect(listed).to.include('keys.json') // so the folder read found it not new: only the check after it saves this start
    expect(readFileSync(home.keysPath, 'utf8')).eq(keys)
    expect(buyerAddresses(readBuyerKeys(home))).deep.eq(buyerAddresses(JSON.parse(keys)))
  })

  it('n4 keys.json written by another first start after the existence check and before the exclusive create: those keys are used, never overwritten', () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-race-create-'))
    const home = buyerHome(join(parent, 'home')) // a new folder: this start goes on to create keys.json
    const keys = otherStartKeys(parent)
    let opened = 0
    const fileSystem = { ...fs, openSync: (path: PathLike, flags: unknown, ...rest: unknown[]) => {
      if (path === home.keysPath && flags === 'wx') { opened++; writeFileSync(home.keysPath, keys, { mode: 0o600 }) }
      return (fs.openSync as (...args: unknown[]) => number)(path, flags, ...rest)
    } } as unknown as HomeFs
    expect(() => initialiseBuyerHome(home.home, fileSystem)).not.to.throw()
    expect(opened).eq(1)
    expect(readFileSync(home.keysPath, 'utf8')).eq(keys)
    expect(existsSync(home.configPath)).eq(true)
  })

  it('n4 a stray file and no keys.json at both checks: still refused with the approved text, and nothing is created', () => {
    const parent = mkdtempSync(join(tmpdir(), 'petasats-race-none-'))
    const home = buildEmptyKitSubfolders(join(parent, 'home'))
    writeFileSync(join(home.home, 'mystery.unknown'), 'x')
    let keysChecks = 0
    const fileSystem = { ...fs, existsSync: (path: PathLike) => { if (path === home.keysPath) keysChecks++; return fs.existsSync(path) } } as unknown as HomeFs
    const before = snapshotTree(home.home)
    expect(() => initialiseBuyerHome(home.home, fileSystem)).to.throw(refusalText(home.home))
    expect(keysChecks).eq(2) // before the folder read and after it
    expect(snapshotTree(home.home)).to.deep.equal(before)
  })
})
