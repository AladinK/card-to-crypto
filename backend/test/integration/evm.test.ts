import ganache from 'ganache';
import solc from 'solc';
import { createPublicClient, createWalletClient, custom, recoverAddress, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAINS } from '../../src/core/assets.js';
import { EvmBlockchainAdapter } from '../../src/blockchain/evm.js';
import { envPrivateKeySigner } from '../../src/blockchain/signers.js';

/**
 * Runs the live EVM adapter against an in-process EVM (ganache) with a real ERC-20 contract compiled
 * here with solc. Exercises: signing and signature recovery, EIP-1559 serialization, broadcast,
 * receipts, Transfer-log verification and idempotent rebroadcast. No network access is needed.
 */
const TOKEN_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract TestUSDC {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  constructor(address holder, uint256 supply) {
    balanceOf[holder] = supply;
    emit Transfer(address(0), holder, supply);
  }
  function transfer(address to, uint256 amount) external returns (bool) {
    require(balanceOf[msg.sender] >= amount, "balance");
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount;
    emit Transfer(msg.sender, to, amount);
    return true;
  }
}`;

function compileToken(): { abi: Abi; bytecode: Hex } {
  const input = {
    language: 'Solidity',
    sources: { 'TestUSDC.sol': { content: TOKEN_SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
  };
  const fatal = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (fatal.length > 0) throw new Error(fatal.map((e) => e.formattedMessage).join('\n'));
  const contract = output.contracts['TestUSDC.sol']?.TestUSDC;
  if (!contract) throw new Error('compilation produced no contract');
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex };
}

describe('EVM adapter against an in-process chain', () => {
  const treasuryKey = generatePrivateKey();
  const treasury = privateKeyToAccount(treasuryKey);
  const recipient = privateKeyToAccount(generatePrivateKey());
  const supply = 1_000_000_000n; // 1000 USDC (6 decimals)
  let provider: ReturnType<typeof ganache.provider>;
  let adapter: EvmBlockchainAdapter;
  let tokenAddress: `0x${string}`;
  const originalTokens = { ...CHAINS.polygon.tokens };

  beforeAll(async () => {
    provider = ganache.provider({
      chain: { chainId: CHAINS.polygon.chainId },
      wallet: { accounts: [{ secretKey: treasuryKey, balance: '0x' + (10n ** 21n).toString(16) }] },
      logging: { quiet: true },
    });
    const transport = custom({ request: provider.request.bind(provider) as never });
    const { abi, bytecode } = compileToken();
    const wallet = createWalletClient({ account: treasury, transport });
    const publicClient = createPublicClient({ transport });
    const deployParams = { abi, bytecode, args: [treasury.address, supply] } as unknown as Parameters<typeof wallet.deployContract>[0];
    const hash = await wallet.deployContract(deployParams);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    tokenAddress = receipt.contractAddress as `0x${string}`;
    expect(tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

    // Point the polygon USDC entry at the deployed test token for this test file only.
    CHAINS.polygon.tokens = { ...originalTokens, USDC: tokenAddress };
    adapter = new EvmBlockchainAdapter({
      chainKey: 'polygon',
      mode: 'live',
      signer: envPrivateKeySigner(treasuryKey),
      transport,
      requiredConfirmations: 1,
    });
  }, 120_000);

  afterAll(() => {
    CHAINS.polygon.tokens = originalTokens;
  });

  it('reads balances and validates addresses', async () => {
    expect(await adapter.getTokenBalance({ address: treasury.address, asset: 'USDC' })).toBe(supply);
    expect(adapter.validateAddress(recipient.address.toLowerCase())).toBe(recipient.address);
    expect(adapter.validateAddress('0x123')).toBeNull();
  });

  it('signs, broadcasts and verifies a USDC transfer on-chain', async () => {
    const amount = 1_500_000n; // 1.5 USDC
    const nonce = await adapter.getNonce(treasury.address);
    const fee = await adapter.estimateFee({ from: treasury.address, to: recipient.address, asset: 'USDC', amountBaseUnits: amount });
    expect(fee.gasLimit).toBeGreaterThan(20_000n);
    expect(fee.costBaseUnits).toBe(fee.gasLimit * fee.maxFeePerGas);

    const prepared = adapter.prepareTransfer({ from: treasury.address, to: recipient.address, asset: 'USDC', amountBaseUnits: amount, nonce, fee });
    const signature = await adapter.treasury.sign(prepared.digest);
    // The signature really is the treasury's: recover the signer from the digest.
    expect(await recoverAddress({ hash: prepared.digest, signature })).toBe(treasury.address);

    const signed = adapter.finalizeTransfer(prepared, signature);
    const { txHash } = await adapter.broadcastTransaction(signed.raw);
    expect(txHash).toBe(signed.txHash);

    expect(await adapter.getTransactionStatus(txHash)).toBe('success');
    expect(await adapter.getConfirmationCount(txHash)).toBeGreaterThanOrEqual(1);
    expect(await adapter.verifyTransferEvent({ txHash, asset: 'USDC', to: recipient.address, amountBaseUnits: amount })).toBe(true);
    expect(await adapter.verifyTransferEvent({ txHash, asset: 'USDC', to: recipient.address, amountBaseUnits: amount + 1n })).toBe(false);
    expect(await adapter.getTokenBalance({ address: recipient.address, asset: 'USDC' })).toBe(amount);
    expect(await adapter.getNonce(treasury.address)).toBe(nonce + 1n);
  });

  it('treats a rebroadcast of a mined transaction as already submitted', async () => {
    const amount = 250_000n;
    const nonce = await adapter.getNonce(treasury.address);
    const fee = await adapter.estimateFee({ from: treasury.address, to: recipient.address, asset: 'USDC', amountBaseUnits: amount });
    const prepared = adapter.prepareTransfer({ from: treasury.address, to: recipient.address, asset: 'USDC', amountBaseUnits: amount, nonce, fee });
    const signed = adapter.finalizeTransfer(prepared, await adapter.treasury.sign(prepared.digest));
    await adapter.broadcastTransaction(signed.raw);
    // Crash-recovery path: the same signed bytes are sent again after the transaction is already mined.
    const again = await adapter.broadcastTransaction(signed.raw);
    expect(again.txHash).toBe(signed.txHash);
  });

  it('reports unknown transactions as not_found, never as success', async () => {
    expect(await adapter.getTransactionStatus(`0x${'ab'.repeat(32)}` as Hex)).toBe('not_found');
  });
});
