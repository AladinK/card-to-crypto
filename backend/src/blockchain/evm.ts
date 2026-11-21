import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseSignature,
  serializeTransaction,
  verifyMessage,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializableEIP1559,
  type Transport,
} from 'viem';
import { CHAINS, type AssetCode, type ChainDef, type ChainKey } from '../core/assets.js';
import type { Mode } from '../core/types.js';
import type { BlockchainAdapter, FeeEstimate, PreparedTransfer, SignedTransfer, Signer, TxStatus } from './types.js';

export const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** Returns the checksummed address, or null when the input is not a valid EVM address. */
export function validateEvmAddress(input: string): `0x${string}` | null {
  if (!isAddress(input)) return null; // strict by default: mixed-case input must have a valid checksum
  return getAddress(input);
}

export async function verifyEvmWalletSignature(input: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  const address = validateEvmAddress(input.address);
  if (!address) return false;
  try {
    return await verifyMessage({ address: address as Address, message: input.message, signature: input.signature as Hex });
  } catch {
    return false;
  }
}

export interface EvmAdapterOptions {
  chainKey: ChainKey;
  mode: Mode;
  signer: Signer;
  rpcUrls?: string[];
  /** Overrides RPC transports (used by tests to run against an in-process EVM). */
  transport?: Transport;
  requiredConfirmations?: number;
}

/** EVM adapter (Ethereum, Polygon, Base, Arbitrum). Settles ERC-20 stablecoins with EIP-1559 transactions. */
export class EvmBlockchainAdapter implements BlockchainAdapter {
  readonly chain: ChainDef;
  readonly mode: Mode;
  readonly requiredConfirmations: number;
  readonly pollIntervalMs: number;
  readonly treasury: Signer;
  private readonly client: PublicClient;

  constructor(options: EvmAdapterOptions) {
    this.chain = CHAINS[options.chainKey];
    this.mode = options.mode;
    this.treasury = options.signer;
    this.requiredConfirmations = options.requiredConfirmations ?? this.chain.defaultConfirmations;
    this.pollIntervalMs = this.chain.pollIntervalMs;
    const transport =
      options.transport ??
      (() => {
        const urls = options.rpcUrls ?? [];
        if (urls.length === 0) throw new Error(`No RPC URL configured for ${options.chainKey}.`);
        // Several providers: viem fails over between them on error.
        return urls.length === 1 ? http(urls[0], { timeout: 10_000 }) : fallback(urls.map((u) => http(u, { timeout: 10_000 })));
      })();
    this.client = createPublicClient({ transport });
  }

  validateAddress(address: string): string | null {
    return validateEvmAddress(address);
  }

  verifyWalletSignature(input: { address: string; message: string; signature: string }): Promise<boolean> {
    return verifyEvmWalletSignature(input);
  }

  private tokenAddress(asset: AssetCode): Address {
    const token = this.chain.tokens[asset];
    if (!token) throw new Error(`${asset} is not supported on ${this.chain.key}.`);
    return token;
  }

  async getTokenBalance({ address, asset }: { address: string; asset: AssetCode }): Promise<bigint> {
    return this.client.readContract({
      address: this.tokenAddress(asset),
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [getAddress(address)],
    });
  }

  getNativeBalance(address: string): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(address) });
  }

  async getNonce(address: string): Promise<bigint> {
    return BigInt(await this.client.getTransactionCount({ address: getAddress(address), blockTag: 'pending' }));
  }

  async estimateFee(input: { from: string; to: string; asset: AssetCode; amountBaseUnits: bigint }): Promise<FeeEstimate> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [getAddress(input.to), input.amountBaseUnits],
    });
    const estimated = await this.client.estimateGas({
      account: getAddress(input.from),
      to: this.tokenAddress(input.asset),
      data,
      value: 0n,
    });
    const fees = await this.client.estimateFeesPerGas();
    const gasLimit = (estimated * 120n) / 100n; // 20% buffer against base-fee movement
    return {
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      costBaseUnits: gasLimit * fees.maxFeePerGas,
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
    const to = getAddress(input.to);
    const tx: TransactionSerializableEIP1559 = {
      type: 'eip1559',
      chainId: this.chain.chainId,
      to: this.tokenAddress(input.asset),
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, input.amountBaseUnits] }),
      nonce: Number(input.nonce),
      gas: input.fee.gasLimit,
      maxFeePerGas: input.fee.maxFeePerGas,
      maxPriorityFeePerGas: input.fee.maxPriorityFeePerGas,
      accessList: [],
    };
    const digest = keccak256(serializeTransaction(tx));
    return {
      chain: this.chain.key,
      asset: input.asset,
      from: getAddress(input.from),
      to,
      amountBaseUnits: input.amountBaseUnits,
      nonce: input.nonce,
      fee: input.fee,
      digest,
      payload: tx,
    };
  }

  finalizeTransfer(prepared: PreparedTransfer, signature: Hex): SignedTransfer {
    const tx = prepared.payload as TransactionSerializableEIP1559;
    const raw = serializeTransaction(tx, parseSignature(signature));
    return { raw, txHash: keccak256(raw) };
  }

  async broadcastTransaction(raw: Hex): Promise<{ txHash: Hex }> {
    const txHash = keccak256(raw);
    try {
      await this.client.sendRawTransaction({ serializedTransaction: raw });
    } catch (error) {
      // A rebroadcast of a transaction that is already pending or mined is not a failure: the nodes
      // report "already known" or "nonce too low". Ask the chain what it knows about this hash.
      const status = await this.getTransactionStatus(txHash).catch(() => 'not_found' as TxStatus);
      if (status === 'not_found') throw error;
    }
    return { txHash };
  }

  async getTransactionStatus(txHash: Hex): Promise<TxStatus> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txHash });
      return receipt.status === 'success' ? 'success' : 'reverted';
    } catch (error) {
      if ((error as Error).name !== 'TransactionReceiptNotFoundError') throw error;
    }
    try {
      await this.client.getTransaction({ hash: txHash });
      return 'pending';
    } catch (error) {
      if ((error as Error).name === 'TransactionNotFoundError') return 'not_found';
      throw error;
    }
  }

  async getConfirmationCount(txHash: Hex): Promise<number> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if ((error as Error).name === 'TransactionReceiptNotFoundError') return 0;
      throw error;
    }
    const head = await this.client.getBlockNumber();
    const depth = head - receipt.blockNumber + 1n;
    return depth > 0n ? Number(depth) : 0;
  }

  async verifyTransferEvent(input: {
    txHash: Hex;
    asset: AssetCode;
    to: string;
    amountBaseUnits: bigint;
  }): Promise<boolean> {
    const receipt = await this.client.getTransactionReceipt({ hash: input.txHash });
    if (receipt.status !== 'success') return false;
    const token = this.tokenAddress(input.asset).toLowerCase();
    const expectedTo = getAddress(input.to);
    return receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== token) return false;
      try {
        const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
        return (
          decoded.eventName === 'Transfer' &&
          getAddress(decoded.args.to) === expectedTo &&
          decoded.args.value === input.amountBaseUnits
        );
      } catch {
        return false;
      }
    });
  }
}

