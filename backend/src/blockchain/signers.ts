import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Signer } from './types.js';

/**
 * Treasury signer backed by an environment private key.
 * DEVELOPMENT/STAGING ONLY. Production must use a KMS/HSM-backed Signer (see docs/DEPLOYMENT.md).
 * The key is never written to the database or to logs.
 */
export function envPrivateKeySigner(privateKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: (digest: Hex) => account.sign({ hash: digest }),
  };
}
