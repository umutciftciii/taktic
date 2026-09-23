import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PackageRefundReasonCode } from './package-refund-eligibility';

/**
 * CMP-006 PR-B — every refusal the refund-request flow can give, as a machine
 * code and a Turkish sentence. None of them names another account, and none is
 * reached by a caller who cannot already see the record: ownership and
 * permission refusals happen first and are 404/403 without a code.
 */

/** The flow is closed: the purchase-terms gate is off, its set is invalid, or the purchase has no evidence. */
export const PACKAGE_REFUND_UNAVAILABLE = 'PACKAGE_REFUND_UNAVAILABLE';
export const PACKAGE_REFUND_NOT_ELIGIBLE = 'PACKAGE_REFUND_NOT_ELIGIBLE';
export const PACKAGE_REFUND_REQUEST_ALREADY_OPEN = 'PACKAGE_REFUND_REQUEST_ALREADY_OPEN';
export const PACKAGE_REFUND_INVALID_TRANSITION = 'PACKAGE_REFUND_INVALID_TRANSITION';
export const PACKAGE_REFUND_NOT_NORMALLY_ELIGIBLE = 'PACKAGE_REFUND_NOT_NORMALLY_ELIGIBLE';
export const PACKAGE_REFUND_NOT_APPLICABLE = 'PACKAGE_REFUND_NOT_APPLICABLE';
export const PACKAGE_REFUND_EXCEPTION_NOT_NEEDED = 'PACKAGE_REFUND_EXCEPTION_NOT_NEEDED';
export const PACKAGE_REFUND_MAKER_CHECKER = 'PACKAGE_REFUND_MAKER_CHECKER';
export const PACKAGE_REFUND_TICKET_NOT_ELIGIBLE = 'PACKAGE_REFUND_TICKET_NOT_ELIGIBLE';
export const PACKAGE_REFUND_TICKET_ALREADY_LINKED = 'PACKAGE_REFUND_TICKET_ALREADY_LINKED';

export function refundUnavailableForProvider() {
  return new ForbiddenException({
    code: PACKAGE_REFUND_UNAVAILABLE,
    message:
      'Paket ve kredi iadesi talebi şu anda bu paket için açılamıyor. Genel destek konusu üzerinden bize yazabilirsiniz.',
  });
}

export function refundUnavailableForOperator() {
  return new ConflictException({
    code: PACKAGE_REFUND_UNAVAILABLE,
    message:
      'İade akışı kapalı (satın alma koşulları kapısı kapalı ya da geçersiz) veya satın almada kabul kanıtı yok.',
  });
}

export function refundNotEligible(blockingCodes: PackageRefundReasonCode[]) {
  return new ConflictException({
    code: PACKAGE_REFUND_NOT_ELIGIBLE,
    blockingCodes,
    message:
      'Bu paket normal iade koşullarını sağlamıyor. Durumunuzu genel destek konusu üzerinden anlatabilirsiniz.',
  });
}

export function refundAlreadyOpen() {
  return new ConflictException({
    code: PACKAGE_REFUND_REQUEST_ALREADY_OPEN,
    message: 'Bu paket için zaten açık bir iade talebi var.',
  });
}

export function refundInvalidTransition(from: string, action: string) {
  return new ConflictException({
    code: PACKAGE_REFUND_INVALID_TRANSITION,
    from,
    message: `İade talebi "${from}" durumundayken bu işlem (${action}) yapılamaz.`,
  });
}

export function refundNotNormallyEligible(blockingCodes: PackageRefundReasonCode[]) {
  return new ConflictException({
    code: PACKAGE_REFUND_NOT_NORMALLY_ELIGIBLE,
    blockingCodes,
    message:
      'Uygunluk yeniden hesaplandı ve normal iade koşulları artık sağlanmıyor. Yalnız gerekçeli istisna onayı mümkün.',
  });
}

export function refundNotApplicable(blockingCodes: PackageRefundReasonCode[]) {
  return new ConflictException({
    code: PACKAGE_REFUND_NOT_APPLICABLE,
    blockingCodes,
    message:
      'Bu satın alma için iade edilebilecek, hâlâ geçerli bir ödeme yok (ödenmemiş, iade edilmiş ya da ters işlem kaydı var).',
  });
}

export function refundExceptionNotNeeded() {
  return new ConflictException({
    code: PACKAGE_REFUND_EXCEPTION_NOT_NEEDED,
    message: 'Normal iade koşulları sağlanıyor; istisna yerine normal onay kullanılmalı.',
  });
}

export function refundMakerChecker() {
  return new ConflictException({
    code: PACKAGE_REFUND_MAKER_CHECKER,
    message:
      'İstisna onayını, talebi açan veya işleme alan yönetici veremez. İkinci bir yetkili onaylamalı.',
  });
}

export function refundTicketNotEligible() {
  return new ConflictException({
    code: PACKAGE_REFUND_TICKET_NOT_ELIGIBLE,
    message:
      'İade isteği yalnız bir hizmet verenin kendi açtığı, kapanmamış destek talebine bağlanabilir.',
  });
}

export function refundTicketAlreadyLinked() {
  return new ConflictException({
    code: PACKAGE_REFUND_TICKET_ALREADY_LINKED,
    message: 'Bu destek talebine zaten bir iade isteği bağlı.',
  });
}
