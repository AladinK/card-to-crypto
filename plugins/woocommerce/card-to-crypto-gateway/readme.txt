=== Card-to-Crypto Gateway for WooCommerce ===
Tags: woocommerce, payment gateway, card payments, crypto, usdc, usdt
Requires at least: 6.5
Requires PHP: 8.1
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Accept card payments in WooCommerce. Customers see a normal card checkout. The merchant receives USDC or USDT in their own wallet.

== Description ==

The Card-to-Crypto gateway adds a "Pay by card" payment method to WooCommerce. When a customer places an order, the plugin creates a CardCrypto payment and sends the customer to the CardCrypto hosted checkout. After the card payment is captured, the order is marked paid. CardCrypto then converts the funds and transfers USDC or USDT to the merchant's default settlement wallet. Settlement events are recorded as order notes.

Card data never touches your server. The plugin sends the order amount and currency, the order id, a short description ("Order 1234"), the billing email, the return and cancel URLs, and metadata (platform, plugin version, WooCommerce order number).

== Requirements ==

* WordPress 6.5 or newer, and PHP 8.1 or newer.
* WooCommerce, active. The classic checkout is supported. The block-based Checkout is not, in this version.
* A CardCrypto account with a test or live API key, a verified default settlement wallet, and a webhook endpoint.

== Installation ==

1. Copy the `card-to-crypto-gateway` folder to `wp-content/plugins/`, or upload the zip under Plugins > Add New.
2. Activate "Card-to-Crypto Gateway for WooCommerce". WooCommerce must already be active. Activation is refused otherwise.
3. Open WooCommerce > Settings > Payments > Card-to-Crypto.

== Configuration ==

1. **API base URL.** The origin of the CardCrypto API, for example `https://api.example.com`. Plain `http` is accepted for `localhost` only, which is the development default `http://localhost:3000`.
2. **Secret key.** Paste `sk_test_...` for test mode or `sk_live_...` for live mode. The prefix selects the mode. The saved key is never shown again. The field shows a masked placeholder, and leaving it blank keeps the saved key.
3. **Webhook signing secret.** Create the webhook endpoint in CardCrypto (see below), then paste the `whsec_...` value that the API returns. It is shown once.
4. **Title, description, "Powered by" line, debug log.** Optional. The "Powered by Crypto Settlement" line appears under the payment method when enabled.
5. Enable the gateway and save.
6. Click **Test connection**. It uses the saved settings, so save first. The test calls `GET /healthz` and `GET /v1/payments?limit=1` with your key.

### Create the webhook endpoint

Paste this URL into CardCrypto when you create the endpoint (dashboard, or `POST /v1/webhook-endpoints`):

    https://your-shop.example/wp-json/card-to-crypto/v1/webhook

If your site uses plain permalinks, the URL is `https://your-shop.example/?rest_route=/card-to-crypto/v1/webhook`. The settings page shows the URL for your site.

Subscribe the endpoint to these events, which are the ones the plugin handles:

    payment.captured, payment.failed, payment.cancelled,
    settlement.confirmed, settlement.failed, refund.completed, refund.failed

The API returns the signing secret once. Copy it into the "Webhook signing secret" field. Live-mode endpoints must use `https`.

== How a payment works ==

1. At checkout the plugin creates a payment (`POST /v1/payments`) with an Idempotency-Key derived from the order id and an attempt counter. A retry of the same attempt cannot create a second payment.
2. The customer is redirected to the hosted checkout and pays by card.
3. CardCrypto captures the payment and sends `payment.captured`. The plugin marks the order paid.
4. The customer returns to the order-received page. The plugin then asks the API for the payment and marks the order paid only if the status is captured or later. The return URL itself is never trusted. If the return check fails, the webhook completes the order.
5. CardCrypto converts and settles USDC or USDT to the default wallet. `settlement.confirmed` and `settlement.failed` add order notes.

If a customer comes back to an order whose checkout is still open, the same checkout is shown again. If the checkout failed or expired, a new payment is created.

== Refunds ==

The plugin never creates refunds. Refund in the CardCrypto dashboard, or through the API. The plugin adds an order note for `refund.completed` and `refund.failed`. WooCommerce's own refund button does not call CardCrypto in this version, so refunds are a manual step.

== Webhooks ==

* Header `CardCrypto-Signature: t=<unix>,v1=<hex>`. The signature is HMAC-SHA256 over `<t>.<raw body>`, keyed with the signing secret. Requests older or newer than 300 seconds are rejected.
* Events are de-duplicated by event id. The last 500 ids are remembered.
* Responses: 200 for handled, ignored, or duplicate events. 400 for an invalid signature or payload. 500 for an internal error or a missing secret, so CardCrypto retries.
* `payment.captured` completes only an order that is pending or on-hold, and only when the amount and currency match. Otherwise the order is left alone and a note is added.
* `payment.failed` and `payment.cancelled` move only a pending order.
* `settlement.failed` adds an "ACTION REQUIRED" note. The order status does not change, because the money was captured.

== Frequently asked questions ==

= Why does "Test connection" not call /v1/me? =

`/v1/me` is for dashboard logins. It rejects API keys. The test uses a payment list call instead.

= Where are the logs? =

WooCommerce > Status > Logs, source `card-to-crypto-gateway`. Errors are always logged. Request-level entries appear only when "Debug log" is on. Keys and secrets are removed before anything is written.

== Limitations ==

* **Classic checkout only.** The block-based Checkout does not show this gateway in this version.
* **One signing secret per endpoint.** A store uses one CardCrypto account and one webhook endpoint. Two stores that share one account need separate endpoints, and their WooCommerce order ids must not collide, because the order id is what CardCrypto records.
* **No automatic refunds.** WooCommerce refunds are not sent to CardCrypto. Refund in the CardCrypto dashboard.
* **Crypto settlement appears as notes only.** The conversion, transaction hash and confirmations are notes. The order status follows the card capture, not the settlement.
* **Settlement asset and network are set in CardCrypto.** The plugin uses the account's default wallet. It does not send settlement preferences.
* **Settlement failure after capture.** The order stays paid, and an action-required note is added. The merchant must resolve the transfer in CardCrypto.
* **Duplicate memory is bounded.** After 500 newer events, a very old event could be processed again. Its order changes are guarded by status, but a duplicate note is possible.
* **Two completion paths.** The return page and the webhook can both try to complete an order at the same moment. WooCommerce's status checks prevent a double completion in practice. This is not a database lock.
* **Order lookup by meta value.** The webhook finds an order by the `_cardcrypto_payment_id` meta value. On very large stores, add an index on postmeta or use HPOS.
* **Store settings are plain text.** Like other WooCommerce gateways, the keys are saved in the `woocommerce_cardcrypto_settings` option. Protect database backups.
* **Checkout expiry.** An abandoned hosted checkout expires after the API's checkout time-to-live. The customer then starts a new payment from checkout.
* **Not yet tested in a live WordPress and WooCommerce site.** See the development notes below.

== Development notes ==

The `tests/` folder runs with plain PHP and no WordPress:

    php tests/SignatureTest.php         # webhook signature verifier, with openssl-computed vectors
    php tests/GatewayHarnessTest.php    # gateway and API client against a test harness
    php tests/WebhookHarnessTest.php    # webhook handler against signed fixtures
    php tests/AdminHarnessTest.php      # settings page, connection-test notice and admin-post handler

The harness in `tests/harness/` stands in for WordPress and WooCommerce functions and for the CardCrypto API. It is not WordPress. A green run shows the plugin's own logic. It does not show how WordPress or WooCommerce behave.

== Changelog ==

= 0.1.0 =
* First version: card checkout through the hosted CardCrypto page, signed webhooks, return-page verification, connection test, and masked secret fields.
