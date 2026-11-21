// Merchant backend route (Node 22). Creates the payment with the SECRET key and returns the hosted checkout URL.
import http from 'node:http';
import { CardCrypto } from '@cardcrypto/sdk';

const cc = new CardCrypto({ secretKey: process.env.CARDCRYPTO_SECRET_KEY, baseUrl: process.env.CARDCRYPTO_API_URL ?? 'http://localhost:3000' });

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/checkout') {
      res.statusCode = 404;
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { orderId } = JSON.parse(raw || '{}');
    try {
      const payment = await cc.payments.create({
        amount: '100.00',
        currency: 'EUR',
        orderId, // take the order total from YOUR database, never from the browser
        returnUrl: 'https://shop.example/thanks',
        cancelUrl: 'https://shop.example/cart',
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ checkout_url: payment.checkout_url }));
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Payment could not be started.' } }));
      console.error('checkout failed', error.code ?? error.message);
    }
  })
  .listen(4000);
