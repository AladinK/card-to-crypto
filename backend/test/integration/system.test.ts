import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';

describe('system routes', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('answers liveness and readiness', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().database).toBe('ok');
  });

  it('serves the OpenAPI specification as YAML', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('yaml');
    expect(res.body).toContain('openapi: 3.1.0');
    expect(res.body).toContain('/v1/payments:');
  });

  it('uses the JSON error envelope for unknown routes and bad JSON', async () => {
    const missing = await h.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const bad = await h.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.type).toBe('invalid_request');
  });

  it('rejects unknown fields in strict request bodies', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { merchant_name: 'X', email: 'x@shop.test', password: 'long enough passphrase', role: 'owner' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('refuses javascript: return URLs', async () => {
    const reg = await h.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { merchant_name: 'Y', email: 'y@shop.test', password: 'long enough passphrase' } });
    const key = await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${reg.json().access_token}` }, payload: { name: 'k', mode: 'test' } });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${key.json().secret}`, 'idempotency-key': 'url-check-0001' },
      payload: { amount: '1.00', currency: 'EUR', order_id: 'U-1', return_url: 'javascript:alert(1)' },
    });
    expect(res.statusCode).toBe(422);
  });
});
