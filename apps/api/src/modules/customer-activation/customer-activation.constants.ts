export const CUSTOMER_ACTIVATION_TOKEN_TTL_HOURS = 72;
export const CUSTOMER_ACTIVATION_PATH = '/activate-customer';

export function getWebAppBaseUrl(): string {
  const candidates = [
    process.env.WEB_APP_URL,
    process.env.WEB_ORIGIN,
    process.env.NEXT_PUBLIC_WEB_URL,
  ];

  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/\/+$/, '');
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return 'http://localhost:3000';
}
