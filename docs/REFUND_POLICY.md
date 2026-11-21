# Refund policy (engineering default; confirm with legal and the acquirer)

1. **Refunds are issued in fiat** through the card processor, against the captured payment. Partial and full refunds are supported. Refunds are allowed only once the crypto settlement is confirmed (`SETTLED` or `PARTIALLY_REFUNDED`). Before that, the authorization is voided or the payment is cancelled.
2. **Crypto is never reversed automatically.** A transfer on a public chain cannot be undone, and mirroring it would move funds without the merchant's consent.
3. **Crypto recovery.** Each successful refund creates a recovery record of the refunded fiat amount: `crypto_recovery_status = OPEN` and `crypto_recovery_fiat_minor`. The merchant owes this amount to the platform, which holds the fiat float that pays the shopper. Recovery is settled by one of: netting against the next settlements (manual in this release), an invoice, or a direct transfer. The dashboard and the analytics endpoint show open recoveries.
4. **Fees.** Processor and network fees are not returned to the merchant by default. The platform fee and conversion fee are non-refundable. This is a policy choice; change it only with a legal review.
5. **Operator refund of crypto** (if a merchant asks for crypto back): handled as a new settlement from the treasury with a fresh quote, approved by a second operator. It is not part of this release.
6. **Timing.** The processor's refund timelines apply (typically 5–10 business days for cards). The `refund.completed` webhook is sent when the processor confirms.
7. **Disputes and chargebacks** follow the processor's dispute process. A lost dispute creates the same crypto recovery as a refund.
