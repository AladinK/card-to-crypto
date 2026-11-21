/**
 * Shopper-side helpers. They never see the secret key: your server creates the payment
 * (see CardCrypto.payments.create) and returns the hosted checkout URL to the page.
 */
export interface CheckoutOptions {
  checkoutUrl: string;
  /** Called before redirecting; return false to cancel. */
  beforeRedirect?: () => boolean | void;
}

export const cryptoPay = {
  /** Sends the shopper to the hosted, PCI-compliant card checkout. */
  checkout(options: CheckoutOptions): void {
    const url = new URL(options.checkoutUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      throw new Error('checkoutUrl must use HTTPS.');
    }
    if (options.beforeRedirect && options.beforeRedirect() === false) return;
    window.location.assign(url.toString());
  },

  /**
   * Binds a button: on click it POSTs to `endpoint` on YOUR backend, which creates the payment and
   * responds with { checkout_url }. The browser then redirects to the hosted checkout.
   */
  bindButton(button: HTMLButtonElement, options: { endpoint: string; body?: () => unknown; onError?: (message: string) => void }): void {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(options.body?.() ?? {}),
        });
        const data = (await response.json()) as { checkout_url?: string; error?: { message?: string } };
        if (!response.ok || !data.checkout_url) throw new Error(data.error?.message ?? 'Payment could not be started.');
        cryptoPay.checkout({ checkoutUrl: data.checkout_url });
      } catch (error) {
        button.disabled = false;
        options.onError?.((error as Error).message);
      }
    });
  },
};
