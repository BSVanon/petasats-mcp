import { expect } from 'chai'
import { describe, it, beforeEach, afterEach } from 'mocha'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync,
  type PathLike,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { assertSecureBuyerHome, buyerHome, initialiseBuyerHome, safeMkdir, secureFileText } from '../../src/sdk/buyer/local-state'

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

  it('with the real constants on Linux: lstat, mkdir, lstat, open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW), fstat, fchmod 0700, close', () => {
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
    expect(statSync(path).mode & 0o777).to.equal(0o700)
  })
})
