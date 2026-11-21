const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isHttpUrl(value: unknown, maxLength = 2048): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}
