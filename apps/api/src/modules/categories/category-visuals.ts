import { BadRequestException } from '@nestjs/common';

export const CATEGORY_ICON_KEYS = [
  'snowflake',
  'flame',
  'bolt',
  'drop',
  'brush',
  'sparkles',
  'truck',
  'box',
  'wrench',
  'tool',
  'book',
] as const;

export type CategoryIconKey = (typeof CATEGORY_ICON_KEYS)[number];

const FORBIDDEN_URL_PREFIXES = [
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'about:',
];

// Path prefixes that indicate a local/container/build path rather than a stable
// public asset. We reject these because the admin form stores the URL as-is and
// nothing rehosts the file. A path that is valid in a developer's machine or
// inside a docker container will return 404 in production.
const FORBIDDEN_PATH_PREFIXES = [
  '/tmp/',
  '/private/',
  '/var/',
  '/Users/',
  '/home/',
  '/root/',
  '/etc/',
  '/opt/',
  '/.next/',
  '/.git/',
  '/node_modules/',
];

const FORBIDDEN_PATH_SUBSTRINGS = ['.next/', 'node_modules/'];

const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;

export function normalizeCategoryImageUrl(
  value: string | null | undefined,
  fieldLabel: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();

  if (WINDOWS_PATH_PATTERN.test(trimmed)) {
    throw new BadRequestException(`${fieldLabel} must be a public URL, not a local path`);
  }

  for (const prefix of FORBIDDEN_URL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      throw new BadRequestException(`${fieldLabel} must use http(s) or a public path`);
    }
  }

  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      throw new BadRequestException(`${fieldLabel} cannot point to a local/build path (${prefix})`);
    }
  }

  for (const fragment of FORBIDDEN_PATH_SUBSTRINGS) {
    if (lower.includes(fragment)) {
      throw new BadRequestException(`${fieldLabel} cannot reference build output (${fragment})`);
    }
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      // Validate that it parses as a real URL with a host.
      const url = new URL(trimmed);
      if (!url.hostname) {
        throw new Error('missing host');
      }
    } catch {
      throw new BadRequestException(`${fieldLabel} is not a valid URL`);
    }
    return trimmed;
  }

  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  throw new BadRequestException(
    `${fieldLabel} must start with http(s):// or be an absolute public path (e.g. /assets/foo.png)`,
  );
}

export function normalizeCategoryIconKey(
  value: string | null | undefined,
): CategoryIconKey | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (!(CATEGORY_ICON_KEYS as readonly string[]).includes(trimmed)) {
    throw new BadRequestException(
      `iconKey must be one of: ${CATEGORY_ICON_KEYS.join(', ')}`,
    );
  }

  return trimmed as CategoryIconKey;
}
