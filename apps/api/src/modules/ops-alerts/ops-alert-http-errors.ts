import { BadRequestException, ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import {
  DuplicateRecipientError,
  LastChannelProtectedError,
  LastCriticalConfirmationRequired,
  RecipientBusyError,
  RecipientDeletedError,
  RecipientLimitReachedError,
  TestRateLimitedError,
  VersionConflictError,
  isLockWaitExpired,
} from './ops-alert-recipients.service';
import {
  ConfirmCancelRequiredError,
  EnvAddressMissingError,
  RoutingBlockedError,
  RoutingCountsChangedError,
  type RoutingBlocker,
} from './ops-alert-routing.service';
import { InvalidRecipientAddressError, RecipientDecryptError } from './recipient-crypto';

/**
 * OBS-ALERT-002 — the recipient and routing services' refusals, over HTTP.
 *
 * Each body is `{ statusCode, error, code, message }`: the code exactly as the
 * service names it, a Turkish message that carries no value — no address, no
 * id, no count. The service's own English messages never reach the client.
 * Anything not recognised here is rethrown untouched.
 */

const CONFLICT_MESSAGES: Record<string, string> = {
  RECIPIENT_LIMIT: 'Alarm alıcısı sınırına ulaşıldı; yeni alıcı eklemek için önce birini silin.',
  RECIPIENT_DUPLICATE: 'Bu adres zaten bir alarm alıcısı.',
  VERSION_CONFLICT: 'Alıcı bu arada başka biri tarafından değiştirildi; sayfayı yenileyip tekrar deneyin.',
  LAST_CRITICAL_CONFIRM_REQUIRED: 'Bu, kritik alarm e-postalarının son alıcısı; devam etmek için onaylayın.',
  LAST_CHANNEL_PROTECTED: 'Bu, production ortamındaki son etkin alarm kanalı; kaldırılamaz.',
  RECIPIENT_DELETED: 'Bu alıcı silinmiş.',
  DECRYPT_FAILED: 'Alıcının adresi açılamadı; şifreleme anahtarlarını kontrol edin.',
  COUNTS_CHANGED: 'Önizlemeden bu yana teslimatlar değişti; yeniden önizleyin.',
  CONFIRM_CANCEL_REQUIRED: 'Geri dönüş bekleyen teslimatları iptal eder; iptali onaylayın.',
  ENV_ADDRESS_MISSING: 'OPS_ALERT_EMAIL tanımlı değil; içe aktarılacak adres yok.',
  RECIPIENT_BUSY: 'Alarm alıcıları şu anda başka bir işlemle değiştiriliyor; biraz sonra tekrar deneyin.',
};

const BLOCKER_MESSAGES: Record<RoutingBlocker, string> = {
  NO_LIVE_CRITICAL_CHANNEL: 'Geçişten sonra kritik alarmlar için etkin bir kanal kalmıyor.',
  LEGACY_ROWS_UNMATCHED: 'Bekleyen eski teslimatların eşleşen etkin bir alıcısı yok.',
  ALREADY_IN_MODE: 'E-posta yönlendirmesi zaten bu modda.',
};

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, error: 'Conflict', code, message });
}

/** The HTTP exception for a known refusal, or the error itself. */
export function toOpsAlertHttpError(error: unknown): unknown {
  if (error instanceof HttpException && !(error instanceof NotFoundException)) return error;
  if (error instanceof NotFoundException) {
    return new NotFoundException({
      statusCode: HttpStatus.NOT_FOUND,
      error: 'Not Found',
      code: 'RECIPIENT_NOT_FOUND',
      message: 'Alıcı bulunamadı.',
    });
  }
  if (error instanceof RoutingBlockedError) {
    return conflict(error.code, BLOCKER_MESSAGES[error.code]);
  }
  if (
    error instanceof RecipientLimitReachedError ||
    error instanceof DuplicateRecipientError ||
    error instanceof VersionConflictError ||
    error instanceof LastCriticalConfirmationRequired ||
    error instanceof LastChannelProtectedError ||
    error instanceof RecipientDeletedError ||
    error instanceof RoutingCountsChangedError ||
    error instanceof ConfirmCancelRequiredError ||
    error instanceof EnvAddressMissingError
  ) {
    return conflict(error.code, CONFLICT_MESSAGES[error.code]!);
  }
  // A lock wait that ran out (the service maps its own; P2028 from anywhere
  // else is the same situation): retryable, never a 500.
  if (error instanceof RecipientBusyError || isLockWaitExpired(error)) {
    return conflict('RECIPIENT_BUSY', CONFLICT_MESSAGES.RECIPIENT_BUSY!);
  }
  if (error instanceof RecipientDecryptError) {
    return conflict('DECRYPT_FAILED', CONFLICT_MESSAGES.DECRYPT_FAILED!);
  }
  if (error instanceof TestRateLimitedError) {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: error.code,
        message: 'Çok fazla test e-postası gönderildi; biraz bekleyip tekrar deneyin.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (error instanceof InvalidRecipientAddressError) {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: 'RECIPIENT_ADDRESS_INVALID',
      message: 'Geçerli bir e-posta adresi girin (yalnız adres, ad olmadan).',
    });
  }
  return error;
}

/** Runs `work`, turning the services' refusals into their HTTP form. */
export async function withOpsAlertHttpErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toOpsAlertHttpError(error);
  }
}
