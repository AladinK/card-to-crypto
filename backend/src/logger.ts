import pino from 'pino';

/** Structured JSON logger. Secrets must never be logged; redaction is a safety net, not a licence. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'cardcrypto' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.secret',
      '*.secret_enc',
      '*.token',
      '*.refresh_token',
      '*.signed_tx',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
