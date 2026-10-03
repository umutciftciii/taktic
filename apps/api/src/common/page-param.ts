import { BadRequestException } from '@nestjs/common';

/**
 * A `?page=` / `?pageSize=` query value: absent or blank means the caller's
 * default, anything but a whole number from 1 to `max` is a 400. Shared by the
 * admin lists that page by number (ADMIN-BACKEND-TRUTH-002).
 */
export function readPageParam(value: string | undefined, name: string, max: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(
      max === Number.MAX_SAFE_INTEGER ? `${name} must be a positive integer` : `${name} must be an integer from 1 to ${max}`,
    );
  }
  return parsed;
}
