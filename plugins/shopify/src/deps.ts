import type { AppConfig } from './config.js';
import type { AppStore } from './db/store.js';
import type { Logger } from './logger.js';
import type { FetchFn } from './types.js';

/** Everything a request handler may touch. Tests inject stubs for each field. */
export interface AppDeps {
  config: AppConfig;
  store: AppStore;
  fetch: FetchFn;
  logger: Logger;
  nowSeconds: () => number;
}

/** Shared by webhook handlers: a stale 'processing' claim becomes reclaimable after this many seconds. */
export function claimTtl(deps: AppDeps): number {
  return deps.config.webhookClaimTtlSeconds;
}

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unexpected_error';
}
