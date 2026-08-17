/**
 * Recipient masking.
 *
 * Everything that reaches a log line or the NotificationLog table goes through
 * one of these. The output must stay useful for support ("is this the right
 * customer?") without being a usable address on its own.
 */

export function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!local || !domain) {
    return '***';
  }

  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/**
 * Keeps the country prefix and the last two digits: enough for a customer to
 * recognise their own number, not enough to dial it.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) {
    return '***';
  }

  const prefix = value.startsWith('+') ? `+${digits.slice(0, 2)}` : digits.slice(0, 2);
  const tail = digits.slice(-2);
  const hiddenCount = Math.max(digits.length - (prefix.replace('+', '').length + tail.length), 0);

  return `${prefix} ${'*'.repeat(hiddenCount)} ${tail}`;
}
