/** Server-side client. Use it only on your backend: the secret key must never reach a browser. */
export interface CardCryptoOptions {
  /** `sk_test_…` or `sk_live_…`. The prefix selects sandbox or live mode. */
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests and for runtimes with a custom fetch. */
  fetch?: typeof fetch;
}

export interface CardCryptoErrorBody {
  type: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
}

export class CardCryptoError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: CardCryptoErrorBody | undefined, fallback: string) {
    super(body?.message ?? fallback);
    this.name = 'CardCryptoError';
    this.status = status;
    this.code = body?.code ?? 'unknown_error';
    this.requestId = body?.request_id;
    this.details = body?.details;
  }
}

export interface CreatePaymentParams {
  /** Decimal string with at most two decimals, e.g. "100.00". */
  amount: string;
  currency: 'EUR' | 'USD' | 'GBP' | 'CHF' | 'CAD' | 'AUD' | 'RSD';
  orderId: string;
  returnUrl: string;
  cancelUrl?: string;
  customerEmail?: string;
  description?: string;
  metadata?: Record<string, string>;
  settlement?: { walletId?: string; blockchain?: 'ethereum' | 'polygon' | 'base' | 'arbitrum'; asset?: 'USDC' | 'USDT' | 'ETH' | 'POL' | 'BTC' };
  /** Generated when omitted. Reuse the same key when retrying the same logical request. */
  idempotencyKey?: string;
}

export interface Payment {
  id: string;
  status: string;
  order_id: string;
  amount: string;
  currency: string;
  checkout_url: string | null;
  [key: string]: unknown;
}

export class CardCrypto {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  readonly payments: {
    create: (params: CreatePaymentParams) => Promise<Payment>;
    retrieve: (id: string) => Promise<Payment>;
    settlement: (id: string) => Promise<Record<string, unknown>>;
    refund: (id: string, params?: { amount?: string; reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent' | 'other'; idempotencyKey?: string }) => Promise<Record<string, unknown>>;
    list: (params?: { limit?: number; status?: string; startingAfter?: string }) => Promise<{ data: Payment[]; has_more: boolean }>;
  };

  readonly transactions: { list: (limit?: number) => Promise<{ data: Record<string, unknown>[] }> };

  readonly exchangeRates: { retrieve: (asset: string, currency: string) => Promise<Record<string, unknown>> };

  constructor(options: CardCryptoOptions) {
    if (!/^sk_(test|live)_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/.test(options.secretKey)) {
      throw new Error('secretKey must be a CardCrypto secret key (sk_test_… or sk_live_…).');
    }
    this.secretKey = options.secretKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.cardcrypto.example').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;

    this.payments = {
      create: (p) => this.createPayment(p),
      retrieve: (id) => this.request('GET', `/v1/payments/${encodeURIComponent(id)}`),
      settlement: (id) => this.request('GET', `/v1/payments/${encodeURIComponent(id)}/settlement`),
      refund: (id, p = {}) =>
        this.request('POST', `/v1/payments/${encodeURIComponent(id)}/refund`, {
          body: { ...(p.amount ? { amount: p.amount } : {}), reason: p.reason ?? 'requested_by_customer' },
          idempotencyKey: p.idempotencyKey ?? newKey(),
        }),
      list: (p = {}) => {
        const query = new URLSearchParams();
        if (p.limit) query.set('limit', String(p.limit));
        if (p.status) query.set('status', p.status);
        if (p.startingAfter) query.set('starting_after', p.startingAfter);
        return this.request('GET', `/v1/payments${query.size ? `?${query}` : ''}`);
      },
    };
    this.transactions = { list: (limit = 25) => this.request('GET', `/v1/transactions?limit=${limit}`) };
    this.exchangeRates = {
      retrieve: (asset, currency) => this.request('GET', `/v1/exchange-rates?asset=${encodeURIComponent(asset)}&currency=${encodeURIComponent(currency)}`),
    };
  }

  private async createPayment(p: CreatePaymentParams): Promise<Payment> {
    return this.request('POST', '/v1/payments', {
      idempotencyKey: p.idempotencyKey ?? newKey(),
      body: {
        amount: p.amount,
        currency: p.currency,
        order_id: p.orderId,
        return_url: p.returnUrl,
        ...(p.cancelUrl ? { cancel_url: p.cancelUrl } : {}),
        ...(p.customerEmail ? { customer: { email: p.customerEmail } } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.metadata ? { metadata: p.metadata } : {}),
        ...(p.settlement ? { settlement: { wallet_id: p.settlement.walletId, blockchain: p.settlement.blockchain, asset: p.settlement.asset } } : {}),
      },
    });
  }

  private async request<T = any>(method: 'GET' | 'POST', path: string, options: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}`, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as unknown) : undefined;
      if (!response.ok) {
        const body = (parsed as { error?: CardCryptoErrorBody } | undefined)?.error;
        throw new CardCryptoError(response.status, body, `Request failed with HTTP ${response.status}.`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}
