import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const dir = await mkdtemp(join(tmpdir(), 'petasats-package-')); const prefix = join(dir, 'prefix'); const home = join(dir, 'home'); await mkdir(prefix); await mkdir(home)
const env = { ...process.env, npm_config_prefix: prefix, PETASATS_HOME: home }
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8', env }))[0].filename
execFileSync('npm', ['install', '-g', '--offline', packed], { stdio: 'inherit', env })
const cli = join(prefix, 'bin', 'petasats-mcp'); const smoke = execFileSync(cli, ['--smoke'], { encoding: 'utf8', env }); if (!/\[smoke\] \d+\/\d+ checks passed\./.test(smoke)) throw new Error('smoke failed')
const init = JSON.parse(execFileSync(cli, ['init'], { encoding: 'utf8', env })); if (!init.base_address || !init.bsv_address) throw new Error('init did not print public addresses')
const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); const baked = JSON.parse(await readFile(new URL('./door-identity.json', import.meta.url))).doorIdentity; if (config.doorIdentity !== baked) throw new Error('baked identity mismatch')
if (((await stat(home)).mode & 0o777) !== 0o700 || ((await stat(join(home, 'keys.json'))).mode & 0o777) !== 0o600) throw new Error('incorrect key permissions')
