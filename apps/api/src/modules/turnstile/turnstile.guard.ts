import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TURNSTILE_ACTION_KEY } from './turnstile.decorators';
import { TurnstileReplayCache } from './turnstile-replay.cache';
import { TURNSTILE_TOKEN_HEADER, TURNSTILE_TOKEN_MAX_LENGTH, type TurnstileAction } from './turnstile.constants';
import { TurnstileVerifierPort } from './turnstile-verifier.port';

export const TURNSTILE_REQUIRED_CODE = 'TURNSTILE_REQUIRED';
export const TURNSTILE_FAILED_CODE = 'TURNSTILE_FAILED';
export const TURNSTILE_UNAVAILABLE_CODE = 'TURNSTILE_UNAVAILABLE';

/**
 * Structural subset of the Express request, declared locally for the reason
 * the phone-verification controller declares its own: the API does not
 * depend on @types/express.
 */
type IncomingRequest = {
  ip?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * The Turnstile gate on a customer-originated write.
 *
 * Runs before the handler, so a refusal here means the service method was
 * never called: no row, no SMS, no mail, no draft consumed, no audit line.
 * Ordered after the route's throttle guard where there is one — a flood of
 * tokenless requests spends its address's budget rather than a siteverify
 * call each — and before the auth guard, because the token is required
 * whether or not a session is present.
 *
 * Three answers, none of which says anything about the account, the number
 * or the request the caller was asking about:
 *
 *   403 TURNSTILE_REQUIRED     no header (or a blank one)
 *   403 TURNSTILE_FAILED       Cloudflare refused it, it named another action
 *                              or hostname, or it has been seen before
 *   503 TURNSTILE_UNAVAILABLE  Cloudflare could not be asked — fail closed;
 *                              the client is told to try again
 *
 * The token is claimed in the replay cache on first sight, before the
 * verifier is asked, so a second presentation of the same token is refused
 * whatever the first one's outcome was and wherever it was presented. The
 * client address handed to Cloudflare is Express `req.ip` — honouring
 * TRUST_PROXY exactly as the throttlers do — and never a header read here.
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  private readonly logger = new Logger(TurnstileGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TurnstileVerifierPort) private readonly verifier: TurnstileVerifierPort,
    @Inject(TurnstileReplayCache) private readonly replay: TurnstileReplayCache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<TurnstileAction | undefined>(TURNSTILE_ACTION_KEY, context.getHandler());
    if (!action) {
      // A route that asked for the guard without naming its operation is a
      // programming error, and the safe answer to one is to refuse.
      this.logger.error(`${context.getClass().name}.${context.getHandler().name} uses TurnstileGuard without @TurnstileAction`);
      throw unavailable();
    }

    const req = context.switchToHttp().getRequest<IncomingRequest>();
    const token = readToken(req);

    if (token !== null) {
      if (token.length > TURNSTILE_TOKEN_MAX_LENGTH || !this.replay.claim(token)) {
        throw failed();
      }
    }

    const verdict = await this.verifier.verify({ token, action, remoteIp: readIp(req) });
    if (verdict.ok) {
      return true;
    }

    switch (verdict.reason) {
      case 'TOKEN_MISSING':
        throw required();
      case 'VERIFIER_UNAVAILABLE':
        throw unavailable();
      default:
        throw failed();
    }
  }
}

function readToken(req: IncomingRequest): string | null {
  const raw = req.headers?.[TURNSTILE_TOKEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function readIp(req: IncomingRequest): string | null {
  return typeof req.ip === 'string' && req.ip ? req.ip : null;
}

function required() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    error: 'Forbidden',
    code: TURNSTILE_REQUIRED_CODE,
    message: 'Güvenlik doğrulaması gerekli.',
  });
}

function failed() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    error: 'Forbidden',
    code: TURNSTILE_FAILED_CODE,
    message: 'Güvenlik doğrulaması başarısız oldu. Lütfen tekrar deneyin.',
  });
}

function unavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    code: TURNSTILE_UNAVAILABLE_CODE,
    message: 'Güvenlik doğrulaması şu anda yapılamıyor. Lütfen tekrar deneyin.',
  });
}
