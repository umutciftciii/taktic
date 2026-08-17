import { BadRequestException } from '@nestjs/common';

/**
 * Normalises a stored customer phone into a single canonical form so the same
 * number cannot dodge a per-phone rate limit by being written differently.
 *
 * Deliberately narrow: Turkish numbers in their common local shapes, plus
 * already-E.164 international input. Anything else is rejected rather than
 * guessed — a wrong guess here would send a code to a stranger.
 *
 * ServiceRequest.customerPhone is already stripped to digits and "+" on write,
 * so this mostly has to decide what the leading digits mean.
 */
export function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) {
    throw new BadRequestException('Phone number is required');
  }

  // Already international: +90..., +49..., 0090...
  if (hasPlus) {
    return assertPlausible(`+${digits}`);
  }

  if (digits.startsWith('00')) {
    return assertPlausible(`+${digits.slice(2)}`);
  }

  // 90XXXXXXXXXX — country code without a plus.
  if (digits.length === 12 && digits.startsWith('90')) {
    return assertPlausible(`+${digits}`);
  }

  // 0XXXXXXXXXX — Turkish national format.
  if (digits.length === 11 && digits.startsWith('0')) {
    return assertPlausible(`+90${digits.slice(1)}`);
  }

  // XXXXXXXXXX — Turkish subscriber number without the trunk zero.
  if (digits.length === 10) {
    return assertPlausible(`+90${digits}`);
  }

  throw new BadRequestException('Phone number format is not supported');
}

function assertPlausible(e164: string): string {
  // E.164 allows at most 15 digits; below 8 is not a reachable subscriber
  // number in any plan we care about.
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    throw new BadRequestException('Phone number format is not supported');
  }

  return e164;
}
