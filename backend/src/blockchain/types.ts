import type { Hex } from 'viem';
import type { AssetCode, ChainDef, ChainKey } from '../core/assets.js';
import type { Mode } from '../core/types.js';

/** Signs 32-byte digests. The treasury key lives behind this interface (KMS/HSM in production). */
export interface Signer {
  readonly address: `0x${string}`;
  sign(digest: Hex): Promise<Hex>;
}

export interface FeeEstimate {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst-case cost in base units of the chain's gas token (e.g. wei). */
  costBaseUnits: bigint;
}

export interface PreparedTransfer {
  chain: ChainKey;
  asset: AssetCode;
  from: `0x${string}`;
  to: `0x${string}`;
  amountBaseUnits: bigint;
  nonce: bigint;
  fee: FeeEstimate;
  /** Hash that the signer must sign. */
  digest: Hex;
  /** Adapter-specific unsigned payload (EVM: transaction object). */
  payload: unknown;
}

export interface SignedTransfer {
  raw: Hex;
  txHash: Hex;
}

export type TxStatus = 'pending' | 'success' | 'reverted' | 'not_found';

/**
 * Blockchain adapter. One implementation per chain family (EVM today; Solana, Bitcoin, Tron later).
 * Only chains with a configured RPC and a passing adapter are activated (see blockchain/registry.ts).
 */
export interface BlockchainAdapter {
  readonly chain: ChainDef;
  readonly mode: Mode;
  readonly requiredConfirmations: number;
  readonly pollIntervalMs: number;
  /** Treasury address and signer that funds merchant settlements. */
  readonly treasury: Signer;

  validateAddress(address: string): string | null;
  verifyWalletSignature(input: { address: string; message: string; signature: string }): Promise<boolean>;

  getTokenBalance(input: { address: string; asset: AssetCode }): Promise<bigint>;
  getNativeBalance(address: string): Promise<bigint>;
  getNonce(address: string): Promise<bigint>;
  estimateFee(input: { from: string; to: string; asset: AssetCode; amountBaseUnits: bigint }): Promise<FeeEstimate>;

  prepareTransfer(input: {
    from: string;
    to: string;
    asset: AssetCode;
    amountBaseUnits: bigint;
    nonce: bigint;
    fee: FeeEstimate;
  }): PreparedTransfer;
  finalizeTransfer(prepared: PreparedTransfer, signature: Hex): SignedTransfer;
  /** Idempotent: re-broadcasting an already known transaction returns its hash. */
  broadcastTransaction(raw: Hex): Promise<{ txHash: Hex }>;

  getTransactionStatus(txHash: Hex): Promise<TxStatus>;
  getConfirmationCount(txHash: Hex): Promise<number>;
  /** Confirms the transaction emitted an ERC-20 Transfer of `amountBaseUnits` to `to` on the expected token. */
  verifyTransferEvent(input: { txHash: Hex; asset: AssetCode; to: string; amountBaseUnits: bigint }): Promise<boolean>;
}
