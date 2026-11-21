# @cardcrypto/sdk

Server client, webhook verification and a shopper-side helper (`cryptoPay.checkout()`).

```ts
import { CardCrypto, verifyWebhook } from '@cardcrypto/sdk';

const cc = new CardCrypto({ secretKey: process.env.CARDCRYPTO_SECRET_KEY!, baseUrl: process.env.CARDCRYPTO_API_URL });
const payment = await cc.payments.create({ amount: '100.00', currency: 'EUR', orderId: 'ORDER-10482', returnUrl: 'https://shop.example/thanks' });
// return { checkout_url: payment.checkout_url } to the browser

const event = verifyWebhook({ signatureHeader: req.headers['cardcrypto-signature'], rawBody: rawBody, secret: process.env.CARDCRYPTO_WEBHOOK_SECRET! });
```

In the browser: `cryptoPay.checkout({ checkoutUrl })` redirects to the hosted checkout. The secret key never reaches the browser.

Run `npm test` from the repository root or in this package (builds, then runs `node --test`).
