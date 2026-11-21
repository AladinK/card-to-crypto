/** Operating mode. `test` = sandbox adapters (fake card, fake chain, fake money). `live` = real providers. */
export type Mode = 'test' | 'live';

/** Deterministic JSON: sorted keys, bigints as strings. Used for idempotency request hashing and audit hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}
