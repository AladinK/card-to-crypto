/**
 * Structured JSON logger. Callers must never pass access tokens, API keys, webhook
 * secrets or raw request bodies as fields; only identifiers and reason codes.
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void => {
    sink(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  };
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
