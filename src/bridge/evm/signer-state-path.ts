import { resolve } from 'node:path'

/** The isolated signer's private state directory, shared by every path resolver that derives signer state. */
export function resolveMakerSignerStatePath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  return resolve(cwd, env.MAKER_SIGNER_STATE ?? ".keys/maker-signer-state")
}
