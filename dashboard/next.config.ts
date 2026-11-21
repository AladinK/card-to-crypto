import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Security headers for every response. Pages get their Content-Security-Policy per request from proxy.ts,
 * because the script policy needs a nonce: Next.js bootstrap scripts cannot run under a static
 * `script-src 'self'`. Setting a static CSP here would be replaced on every page, so the JSON API below
 * carries its own policy instead.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Silences the "multiple lockfiles" workspace-root guess: this app is not part of the parent npm workspace.
  outputFileTracingRoot: projectRoot,
  turbopack: { root: projectRoot },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
