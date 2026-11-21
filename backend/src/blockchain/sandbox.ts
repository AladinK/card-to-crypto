import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { CHAINS, type AssetCode, type ChainDef, type ChainKey } from '../core/assets.js';
import { hmacHex, sha256Hex } from '../core/security.js';
import { verifyEvmWalletSignature, validateEvmAddress } from './evm.js';
import type { BlockchainAdapter, FeeEstimate, PreparedTransfer, SignedTransfer, Signer, TxStatus } from './types.js';

/** Sandbox treasury address (deterministic, not a real account). */
export const SANDBOX_TREASURY_ADDRESS = getAddress(`0x${keccak256(toHex('cardcrypto-sandbox-treasury')).slice(-40)}`);

/** Sandbox-only "sanctioned" address: lets tests and demos exercise the sanctions hold path. */
export const SANDBOX_SANCTIONED_ADDRESS = '0x000000000000000000000000000000000000dEaD';

interface SandboxTx {
  submittedAtMs: number;
  amountBaseUnits: bigint;
  to: string;
  asset: AssetCode;
}

export interface SandboxChainOptions {
  chainKey: ChainKey;
  secret: string;
  /** Sandbox settles with a small confirmation count so end-to-end runs in seconds. */
  requiredConfirmations?: number;
  /** Simulated block time. */
  blockTimeMs?: number;
  /** Simulated time from broadcast to inclusion. */
  inclusionDelayMs?: number;
  now?: () => number;
}

/**
 * Sandbox chain: simulated transactions with real EVM address validation and real wallet signatures.
 * Money never moves. Transaction state is kept in memory; if it is lost (process restart) the
 * settlement job re-broadcasts the signed payload, which is idempotent.
 */
export class SandboxChainAdapter implements BlockchainAdapter {
  readonly chain: ChainDef;
  readonly mode = 'test' as const;
  readonly requiredConfirmations: number;
  readonly pollIntervalMs: number;
  readonly treasury: Signer;
  private readonly txs = new Map<string, SandboxTx>();
  private readonly nonces = new Map<string, bigint>();
  private readonly options: Required<Omit<SandboxChainOptions, 'chainKey' | 'secret'>> & { secret: string };

  constructor(options: SandboxChainOptions) {
    this.chain = CHAINS[options.chainKey];
    this.requiredConfirmations = options.requiredConfirmations ?? 3;
    this.pollIntervalMs = options.blockTimeMs ?? 1_000;
    this.options = {
      secret: options.secret,
      requiredConfirmations: this.requiredConfirmations,
      blockTimeMs: this.pollIntervalMs,
      inclusionDelayMs: options.inclusionDelayMs ?? 1_500,
      now: options.now ?? (() => Date.now()),
    };
    this.treasury = {
      address: SANDBOX_TREASURY_ADDRESS,
      sign: async (digest: Hex) => `0x${hmacHex(options.secret, digest)}` as Hex,
    };
  }

  validateAddress(address: string): string | null {
    if (address.toLowerCase() === SANDBOX_SANCTIONED_ADDRESS.toLowerCase()) return getAddress(address);
    return validateEvmAddress(address);
  }

  verifyWalletSignature(input: { address: string; message: string; signature: string }): Promise<boolean> {
    return verifyEvmWalletSignature(input);
  }

  async getTokenBalance(): Promise<bigint> {
    // Sandbox float: enough for any test settlement.
    return 1_000_000_000_000n;
  }

  async getNativeBalance(): Promise<bigint> {
    return 10n ** 21n;
  }

  async getNonce(address: string): Promise<bigint> {
    return this.nonces.get(address.toLowerCase()) ?? 0n;
  }

  async estimateFee(): Promise<FeeEstimate> {
    const gasLimit = 65_000n;
    const maxFeePerGas = 1_000_000_000n;
    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: 100_000_000n,
      costBaseUnits: gasLimit * maxFeePerGas,
    };
  }

  prepareTransfer(input: {
    from: string;
    to: string;
    asset: AssetCode;
    amountBaseUnits: bigint;
    nonce: bigint;
    fee: FeeEstimate;
  }): PreparedTransfer {
    const payload = {
      chainId: this.chain.chainId,
      from: input.from.toLowerCase(),
      to: getAddress(input.to),
      asset: input.asset,
      amount: input.amountBaseUnits.toString(),
      nonce: input.nonce.toString(),
    };
    const digest = `0x${sha256Hex(JSON.stringify(payload))}` as Hex;
    return {
      chain: this.chain.key,
      asset: input.asset,
      from: getAddress(input.from),
      to: getAddress(input.to),
      amountBaseUnits: input.amountBaseUnits,
      nonce: input.nonce,
      fee: input.fee,
      digest,
      payload,
    };
  }

  finalizeTransfer(prepared: PreparedTransfer, signature: Hex): SignedTransfer {
    const raw = `0x${Buffer.from(JSON.stringify({ payload: prepared.payload, signature })).toString('hex')}` as Hex;
    const txHash = `0x${sha256Hex(raw)}` as Hex;
    return { raw, txHash };
  }

  async broadcastTransaction(raw: Hex): Promise<{ txHash: Hex }> {
    const decoded = JSON.parse(Buffer.from(raw.slice(2), 'hex').toString('utf8')) as {
      payload: { from: string; to: string; asset: AssetCode; amount: string; nonce: string };
    };
    const txHash = `0x${sha256Hex(raw)}` as Hex;
    if (!this.txs.has(txHash)) {
      this.txs.set(txHash, {
        submittedAtMs: this.options.now(),
        amountBaseUnits: BigInt(decoded.payload.amount),
        to: decoded.payload.to,
        asset: decoded.payload.asset,
      });
      const from = decoded.payload.from;
      const next = BigInt(decoded.payload.nonce) + 1n;
      if ((this.nonces.get(from) ?? 0n) < next) this.nonces.set(from, next);
    }
    return { txHash };
  }

  async getTransactionStatus(txHash: Hex): Promise<TxStatus> {
    const tx = this.txs.get(txHash);
    if (!tx) return 'not_found';
    return this.options.now() - tx.submittedAtMs < this.options.inclusionDelayMs ? 'pending' : 'success';
  }

  async getConfirmationCount(txHash: Hex): Promise<number> {
    const tx = this.txs.get(txHash);
    if (!tx) return 0;
    const elapsed = this.options.now() - tx.submittedAtMs - this.options.inclusionDelayMs;
    if (elapsed < 0) return 0;
    return Math.min(this.requiredConfirmations, 1 + Math.floor(elapsed / this.options.blockTimeMs));
  }

  async verifyTransferEvent(input: {
    txHash: Hex;
    asset: AssetCode;
    to: string;
    amountBaseUnits: bigint;
  }): Promise<boolean> {
    const tx = this.txs.get(input.txHash);
    if (!tx) return false;
    return tx.asset === input.asset && tx.to === getAddress(input.to) && tx.amountBaseUnits === input.amountBaseUnits;
  }
}

/** Convenience for the registry: all chains that carry at least one stablecoin. */
export function sandboxChainKeys(): ChainKey[] {
  return (Object.keys(CHAINS) as ChainKey[]).filter((k) => Object.keys(CHAINS[k].tokens).length > 0);
}
