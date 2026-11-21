import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return true; // not an IP literal: treat as unsafe
}

export interface SafePostResult {
  status: number;
  durationMs: number;
}

/**
 * POST for outbound webhooks. Protections:
 *  - HTTPS only (HTTP allowed only when explicitly enabled for local development)
 *  - the address is validated at connect time (defeats DNS rebinding between check and connect)
 *  - no redirects are followed, response body is discarded, hard timeout
 */
export function safePost(
  rawUrl: string,
  headers: Record<string, string>,
  body: string,
  options: { timeoutMs: number; allowPrivate: boolean },
): Promise<SafePostResult> {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === 'https:';
  if (!isHttps && !(options.allowPrivate && url.protocol === 'http:')) {
    return Promise.reject(new Error('insecure_webhook_url'));
  }
  const transport = isHttps ? https : http;
  const started = Date.now();

  const lookup = (
    hostname: string,
    lookupOptions: { all?: boolean },
    callback: (error: Error | null, address: unknown, family?: number) => void,
  ): void => {
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const blocked = addresses.some((a) => !options.allowPrivate && isPrivateAddress(a.address));
      if (blocked) return callback(new Error('blocked_destination_address'), '');
      if (addresses.length === 0) return callback(new Error('dns_no_address'), '');
      if (lookupOptions.all) return callback(null, addresses);
      const first = addresses[0];
      return callback(null, first?.address ?? '', first?.family);
    });
  };

  return new Promise<SafePostResult>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
        timeout: options.timeoutMs,
        lookup,
      } as https.RequestOptions,
      (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode ?? 0, durationMs: Date.now() - started }));
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(body);
  });
}
