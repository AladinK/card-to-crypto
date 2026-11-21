/** Required by the task: <name>.myshopify.com with an alphanumeric/hyphen label. */
const SHOP_DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && SHOP_DOMAIN.test(value);
}

/** Lower-cases a valid shop domain (used as the storage key), or returns null. */
export function normalizeShop(value: string | null | undefined): string | null {
  if (!isValidShopDomain(value)) return null;
  return value.toLowerCase();
}
