/** Injectable HTTP client. Production passes globalThis.fetch; tests pass a stub. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
