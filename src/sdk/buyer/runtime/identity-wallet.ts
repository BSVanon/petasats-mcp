/** A BRC-31 identity wallet, deliberately unable to hold or move funds. */
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'

const unsupported = (): never => {
  throw new Error('not supported by the buyer kit identity wallet')
}

/**
 * Supplies exactly ProtoWallet's derivation and cryptographic operations to
 * AuthFetch/Peer.  The structural WalletInterface adapter is necessary because
 * those SDK APIs currently require the larger wallet interface.
 */
class IdentityOnlyWallet extends ProtoWallet implements WalletInterface {
  constructor(identityKey: PrivateKey) { super(identityKey) }

  // Wallet state / actions / outputs.
  async createAction(..._args: unknown[]): Promise<never> { return unsupported() }
  async signAction(..._args: unknown[]): Promise<never> { return unsupported() }
  async abortAction(..._args: unknown[]): Promise<never> { return unsupported() }
  async listActions(..._args: unknown[]): Promise<never> { return unsupported() }
  async internalizeAction(..._args: unknown[]): Promise<never> { return unsupported() }
  async listOutputs(..._args: unknown[]): Promise<never> { return unsupported() }
  async relinquishOutput(..._args: unknown[]): Promise<never> { return unsupported() }

  // Certificates and chain/wallet metadata are intentionally unavailable.
  async acquireCertificate(..._args: unknown[]): Promise<never> { return unsupported() }
  async listCertificates(..._args: unknown[]): Promise<never> { return unsupported() }
  async proveCertificate(..._args: unknown[]): Promise<never> { return unsupported() }
  async relinquishCertificate(..._args: unknown[]): Promise<never> { return unsupported() }
  async discoverByIdentityKey(..._args: unknown[]): Promise<never> { return unsupported() }
  async discoverByAttributes(..._args: unknown[]): Promise<never> { return unsupported() }
  async isAuthenticated(..._args: unknown[]): Promise<never> { return unsupported() }
  async waitForAuthentication(..._args: unknown[]): Promise<never> { return unsupported() }
  async getHeight(..._args: unknown[]): Promise<never> { return unsupported() }
  async getHeaderForHeight(..._args: unknown[]): Promise<never> { return unsupported() }
  async getNetwork(..._args: unknown[]): Promise<never> { return unsupported() }
  async getVersion(..._args: unknown[]): Promise<never> { return unsupported() }
}

export function makeIdentityOnlyWallet(identityKey: PrivateKey): WalletInterface {
  return new IdentityOnlyWallet(identityKey)
}
