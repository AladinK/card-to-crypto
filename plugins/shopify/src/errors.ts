/**
 * Retrying the same input cannot succeed (malformed payload, unsupported currency,
 * amount mismatch, Shopify userErrors, backend validation). Webhook handlers acknowledge
 * these with 200 so the sender stops retrying, and log them for an operator.
 */
export class PermanentError extends Error {
  readonly kind = 'permanent';
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PermanentError';
  }
}

/**
 * Worth retrying later (network failure, timeout, 429, 5xx, credentials that may be fixed).
 * Webhook handlers answer 500 so the sender retries.
 */
export class TransientError extends Error {
  readonly kind = 'transient';
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'TransientError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export function isPermanentError(error: unknown): error is PermanentError {
  return error instanceof PermanentError;
}
