import { randomBytes } from 'node:crypto';
import { CHAINS, isAssetCode, isChainKey, type AssetCode, type ChainKey } from '../core/assets.js';
import { AppError, err } from '../core/errors.js';
import { newId } from '../core/security.js';
import type { Mode } from '../core/types.js';
import type { BlockchainAdapter } from '../blockchain/types.js';
import { appendAudit } from '../audit/audit.js';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import type { AuthContext } from '../merchant/auth.js';
import { canWrite } from '../merchant/auth.js';
import { requireMerchant } from '../merchant/service.js';

export const VERIFICATION_TTL_MINUTES = 15;

export interface WalletRecord {
  id: string;
  blockchain: ChainKey;
  asset: AssetCode;
  address: string;
  status: 'UNVERIFIED' | 'VERIFIED' | 'DISABLED';
  is_default: boolean;
  verified_at: Date | null;
  created_at: Date;
}

export function mapWallet(row: Record<string, unknown>): WalletRecord {
  return {
    id: String(row.id),
    blockchain: row.blockchain as ChainKey,
    asset: row.asset as AssetCode,
    address: String(row.address),
    status: row.status as WalletRecord['status'],
    is_default: Boolean(row.is_default),
    verified_at: row.verified_at ? new Date(String(row.verified_at)) : null,
    created_at: new Date(String(row.created_at)),
  };
}

/** A wallet can receive live money only after verification plus the activation delay (settlement protection). */
export function isWalletUsable(wallet: Pick<WalletRecord, 'status' | 'verified_at'>, mode: Mode, activationDelayHours: number, now = Date.now()): boolean {
  if (wallet.status !== 'VERIFIED' || !wallet.verified_at) return false;
  if (mode === 'test') return true;
  return now >= wallet.verified_at.getTime() + activationDelayHours * 3_600_000;
}

export function verificationMessage(input: { merchantId: string; address: string; blockchain: string; asset: string; expiresAt: Date }): string {
  const nonce = randomBytes(16).toString('hex');
  return [
    'CardCrypto wallet verification',
    `Merchant: ${input.merchantId}`,
    `Wallet: ${input.address}`,
    `Chain: ${input.blockchain}`,
    `Asset: ${input.asset}`,
    `Nonce: ${nonce}`,
    `Expires: ${input.expiresAt.toISOString()}`,
  ].join('\n');
}

export interface WalletDeps {
  db: Db;
  activationDelayHours: number;
  /** Any adapter for the chain (used for address and signature validation; same rules in every mode). */
  adapterFor: (chain: ChainKey) => BlockchainAdapter;
  screenAddress: (address: string, chain: ChainKey) => Promise<'clear' | 'hit' | 'review'>;
}

export class WalletService {
  constructor(private readonly deps: WalletDeps) {}

  async list(merchantId: string, mode: Mode): Promise<Record<string, unknown>[]> {
    const { rows } = await this.deps.db.query('SELECT * FROM wallets WHERE merchant_id = $1 ORDER BY created_at', [merchantId]);
    return rows.map((row) => {
      const wallet = mapWallet(row);
      return this.view(wallet, mode, row.verification_expires_at as Date | null);
    });
  }

  async add(ctx: AuthContext, input: { blockchain: string; asset: string; address: string }): Promise<Record<string, unknown>> {
    const merchantId = requireMerchant(ctx);
    if (!canWrite(ctx)) throw err.forbidden('forbidden', 'Viewers cannot change settlement wallets.');
    if (!isChainKey(input.blockchain)) throw err.unprocessable('unsupported_chain', `Unsupported blockchain "${input.blockchain}".`);
    if (!isAssetCode(input.asset)) throw err.unprocessable('unsupported_asset', `Unsupported asset "${input.asset}".`);
    if (!CHAINS[input.blockchain].tokens[input.asset]) {
      throw err.unprocessable('unsupported_asset_for_chain', `${input.asset} is not settled on ${CHAINS[input.blockchain].name}.`);
    }

    const adapter = this.deps.adapterFor(input.blockchain);
    const address = adapter.validateAddress(input.address);
    if (!address) throw err.unprocessable('invalid_address', 'The wallet address is not valid for this blockchain.');

    if ((await this.deps.screenAddress(address, input.blockchain)) !== 'clear') {
      throw err.unprocessable('address_not_allowed', 'This address cannot be used for settlements.');
    }

    const id = newId('wal');
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60_000);
    const message = verificationMessage({ merchantId, address, blockchain: input.blockchain, asset: input.asset, expiresAt });

    await withTransaction(this.deps.db, async (tx) => {
      try {
        await tx.query(
          `INSERT INTO wallets (id, merchant_id, blockchain, asset, address, status, verification_message, verification_expires_at)
           VALUES ($1, $2, $3, $4, $5, 'UNVERIFIED', $6, $7)`,
          [id, merchantId, input.blockchain, input.asset, address, message, expiresAt],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw err.conflict('wallet_exists', 'This wallet is already registered.');
        throw error;
      }
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'wallet.added',
        entityType: 'wallet',
        entityId: id,
        data: { blockchain: input.blockchain, asset: input.asset },
        ip: ctx.ip,
      });
    });

    return { ...this.view(mapWallet({ id, blockchain: input.blockchain, asset: input.asset, address, status: 'UNVERIFIED', is_default: false, verified_at: null, created_at: new Date() }), ctx.mode, expiresAt), verification: { message, expires_at: expiresAt.toISOString(), instructions: 'Sign this exact message with the wallet and submit the signature to POST /v1/wallet/{id}/verify.' } };
  }

  /** Proves control of the address by verifying a signature over the issued message. */
  async verify(ctx: AuthContext, walletId: string, signature: string): Promise<Record<string, unknown>> {
    const merchantId = requireMerchant(ctx);
    if (!canWrite(ctx)) throw err.forbidden('forbidden', 'Viewers cannot verify wallets.');
    const row = await this.loadOwned(this.deps.db, merchantId, walletId);
    if (row.status === 'VERIFIED') return this.view(mapWallet(row), ctx.mode, null);
    if (row.status === 'DISABLED') throw err.conflict('wallet_disabled', 'This wallet is disabled.');
    if (!row.verification_expires_at || new Date(row.verification_expires_at) < new Date()) {
      throw err.unprocessable('verification_expired', 'Verification window expired. Add the wallet again.');
    }

    const adapter = this.deps.adapterFor(row.blockchain as ChainKey);
    const ok = await adapter.verifyWalletSignature({ address: row.address, message: row.verification_message, signature });
    if (!ok) throw err.unprocessable('invalid_signature', 'Signature does not match the wallet address.');

    await withTransaction(this.deps.db, async (tx) => {
      await tx.query(
        `UPDATE wallets SET status = 'VERIFIED', verified_at = now(), verification_message = NULL, verification_expires_at = NULL
         WHERE id = $1 AND status = 'UNVERIFIED'`,
        [walletId],
      );
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'wallet.verified',
        entityType: 'wallet',
        entityId: walletId,
        ip: ctx.ip,
      });
    });
    const fresh = await this.loadOwned(this.deps.db, merchantId, walletId);
    return this.view(mapWallet(fresh), ctx.mode, null);
  }

  async setDefault(ctx: AuthContext, walletId: string): Promise<Record<string, unknown>> {
    const merchantId = requireMerchant(ctx);
    if (!canWrite(ctx)) throw err.forbidden('forbidden', 'Viewers cannot change settlement wallets.');
    await withTransaction(this.deps.db, async (tx) => {
      const row = await this.loadOwned(tx, merchantId, walletId);
      if (row.status !== 'VERIFIED') throw err.unprocessable('wallet_not_verified', 'Only verified wallets can be the default.');
      await tx.query('UPDATE wallets SET is_default = FALSE WHERE merchant_id = $1 AND blockchain = $2 AND asset = $3 AND is_default', [
        merchantId,
        row.blockchain,
        row.asset,
      ]);
      await tx.query('UPDATE wallets SET is_default = TRUE WHERE id = $1', [walletId]);
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'wallet.default_set',
        entityType: 'wallet',
        entityId: walletId,
        ip: ctx.ip,
      });
    });
    return this.view(mapWallet(await this.loadOwned(this.deps.db, merchantId, walletId)), ctx.mode, null);
  }

  async disable(ctx: AuthContext, walletId: string): Promise<void> {
    const merchantId = requireMerchant(ctx);
    if (!canWrite(ctx)) throw err.forbidden('forbidden', 'Viewers cannot change settlement wallets.');
    await withTransaction(this.deps.db, async (tx) => {
      await this.loadOwned(tx, merchantId, walletId);
      await tx.query("UPDATE wallets SET status = 'DISABLED', is_default = FALSE WHERE id = $1", [walletId]);
      await appendAudit(tx, {
        actorType: ctx.kind === 'user' ? 'user' : 'api_key',
        actorId: ctx.userId ?? ctx.apiKeyId,
        merchantId,
        action: 'wallet.disabled',
        entityType: 'wallet',
        entityId: walletId,
        ip: ctx.ip,
      });
    });
  }

  /** Resolves the settlement wallet for a payment: explicit id, or the unique default matching the filters. */
  async resolveForPayment(
    db: Queryable,
    merchantId: string,
    mode: Mode,
    filter: { walletId?: string | undefined; blockchain?: string | undefined; asset?: string | undefined },
  ): Promise<WalletRecord> {
    const { rows } = filter.walletId
      ? await db.query('SELECT * FROM wallets WHERE id = $1 AND merchant_id = $2', [filter.walletId, merchantId])
      : await db.query(
          `SELECT * FROM wallets WHERE merchant_id = $1 AND is_default AND status = 'VERIFIED'
             AND ($2::text IS NULL OR blockchain = $2) AND ($3::text IS NULL OR asset = $3)`,
          [merchantId, filter.blockchain ?? null, filter.asset ?? null],
        );
    if (!filter.walletId && rows.length === 0) {
      throw err.unprocessable('no_settlement_wallet', 'No verified default wallet matches. Add and verify a settlement wallet first.');
    }
    if (!filter.walletId && rows.length > 1) {
      throw err.unprocessable('settlement_wallet_ambiguous', 'Several default wallets match. Specify settlement.blockchain and settlement.asset.');
    }
    const row = rows[0];
    if (!row) throw err.notFound('Wallet');
    const wallet = mapWallet(row);
    if (!isWalletUsable(wallet, mode, this.deps.activationDelayHours)) {
      throw err.unprocessable('wallet_not_active', 'Wallet is not verified or still in its activation period.');
    }
    return wallet;
  }

  private async loadOwned(db: Queryable, merchantId: string, walletId: string): Promise<Record<string, unknown> & { status: string; address: string; blockchain: string; asset: string; verification_message: string; verification_expires_at: Date | null }> {
    const { rows } = await db.query('SELECT * FROM wallets WHERE id = $1 AND merchant_id = $2', [walletId, merchantId]);
    const row = rows[0];
    if (!row) throw err.notFound('Wallet');
    return row;
  }

  private view(wallet: WalletRecord, mode: Mode, verificationExpiresAt: Date | null): Record<string, unknown> {
    const usable = isWalletUsable(wallet, mode, this.deps.activationDelayHours);
    return {
      id: wallet.id,
      blockchain: wallet.blockchain,
      asset: wallet.asset,
      address: wallet.address,
      status: wallet.status,
      is_default: wallet.is_default,
      verified_at: wallet.verified_at?.toISOString() ?? null,
      usable_for_settlement: usable,
      verification_expires_at: verificationExpiresAt?.toISOString() ?? null,
      created_at: wallet.created_at.toISOString(),
    };
  }
}
