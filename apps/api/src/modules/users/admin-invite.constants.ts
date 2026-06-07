export const ADMIN_INVITE_TOKEN_TTL_HOURS = 72;
export const ADMIN_INVITE_PATH = '/admin-invite';

export function getAdminAppBaseUrl(): string {
  const candidates = [
    process.env.ADMIN_APP_URL,
    process.env.ADMIN_ORIGIN,
    process.env.NEXT_PUBLIC_ADMIN_URL,
  ];

  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/\/+$/, '');
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return 'http://localhost:3002';
}
