import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const dir = await mkdtemp(join(tmpdir(), 'petasats-package-')); const prefix = join(dir, 'prefix'); const home = join(dir, 'home'); await mkdir(prefix); await mkdir(home)
const env = { ...process.env, npm_config_prefix: prefix, PETASATS_HOME: home }
// On Windows npm and the installed launcher are .cmd files, which Node starts only through a shell, so their JavaScript entry points run under node instead
const win = process.platform === 'win32'
if (win && !process.env.npm_execpath) throw new Error('on Windows, run this through npm run verify')
const npm = (args, options) => win ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options) : execFileSync('npm', args, options)
const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], { encoding: 'utf8', env }))[0].filename
npm(['install', '-g', '--offline', packed], { stdio: 'inherit', env })
const bin = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).bin['petasats-mcp']; if (win) await stat(join(prefix, 'petasats-mcp.cmd'))
const cli = (args) => win ? execFileSync(process.execPath, [join(prefix, 'node_modules', 'petasats-mcp', bin), ...args], { encoding: 'utf8', env }) : execFileSync(join(prefix, 'bin', 'petasats-mcp'), args, { encoding: 'utf8', env })
const smoke = cli(['--smoke']); if (!/\[smoke\] \d+\/\d+ checks passed\./.test(smoke)) throw new Error('smoke failed')
const init = JSON.parse(cli(['init'])); if (!init.base_address || !init.bsv_address) throw new Error('init did not print public addresses')
const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); const baked = JSON.parse(await readFile(new URL('./door-identity.json', import.meta.url))).doorIdentity; if (config.doorIdentity !== baked) throw new Error('baked identity mismatch')
// Windows reports synthesized mode bits, so the owner-only check runs off Windows only
if (!win && (((await stat(home)).mode & 0o777) !== 0o700 || ((await stat(join(home, 'keys.json'))).mode & 0o777) !== 0o600)) throw new Error('incorrect key permissions')
