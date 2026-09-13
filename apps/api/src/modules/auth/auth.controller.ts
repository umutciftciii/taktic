import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { CustomerActivationService } from '../customer-activation/customer-activation.service';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { AuthService } from './auth.service';
import { EmailAlreadyRegisteredException } from './auth.errors';
import { AuthThrottlerGuard } from './auth.throttler';
import { clearSessionCookie, getSessionIdFromRequest, sessionCookie } from './cookie';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/** Signals the client that this e-mail needs mailbox verification, not a password. */
export const ACTIVATION_REQUIRED_CODE = 'ACTIVATION_REQUIRED';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(CustomerActivationService)
    private readonly activationService: CustomerActivationService,
    @Inject(EmailVerificationService)
    private readonly emailVerification: EmailVerificationService,
  ) {}

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  async login(@Body() dto: LoginDto, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await this.authService.login(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
      currentSessionId: getSessionIdFromRequest(request),
    });

    response.setHeader(
      'Set-Cookie',
      sessionCookie(result.sessionId, result.expiresAt, result.rememberMe),
    );
    return result.user;
  }

  @Post('register-customer')
  @UseGuards(AuthThrottlerGuard)
  async registerCustomer(
    @Body() dto: RegisterDto,
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
  ) {
    let result;
    try {
      result = await this.authService.registerCustomer(dto, {
        ipAddress: request.ip ?? null,
        userAgent: request.headers?.['user-agent'] ?? null,
        currentSessionId: getSessionIdFromRequest(request),
      });
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredException) {
        // The address may belong to an account the platform auto-created for a
        // guest service request. Those have no password, so instead of a
        // dead-end "already registered" we re-send the activation link. The
        // response never carries the token: proving mailbox ownership stays
        // mandatory, so this cannot be used to take over the account.
        const claim = await this.activationService.requestActivationForEmail(dto.email);
        if (claim) {
          throw new ConflictException({
            statusCode: 409,
            code: ACTIVATION_REQUIRED_CODE,
            message:
              'Bu e-posta ile daha önce talep oluşturulmuş. Hesabınızı etkinleştirmeniz için bağlantı gönderildi.',
          });
        }
      }

      throw error;
    }

    // The account exists and the customer is signed in, so proving mailbox
    // ownership happens alongside — not in front of — the registration. The
    // call swallows its own failures for the same reason the guest activation
    // link does: a mail problem must not turn a completed registration into an
    // error the visitor sees.
    await this.emailVerification.issueForNewCustomer(result.user.id);

    response.setHeader(
      'Set-Cookie',
      sessionCookie(result.sessionId, result.expiresAt, result.rememberMe),
    );
    return result.user;
  }

  @Post('register-provider')
  @UseGuards(AuthThrottlerGuard)
  async registerProvider(
    @Body() dto: RegisterDto,
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const result = await this.authService.registerProvider(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
      currentSessionId: getSessionIdFromRequest(request),
    });

    response.setHeader(
      'Set-Cookie',
      sessionCookie(result.sessionId, result.expiresAt, result.rememberMe),
    );
    return result.user;
  }

  @Post('logout')
  async logout(@Req() request: any, @Res({ passthrough: true }) response: any) {
    await this.authService.logout(getSessionIdFromRequest(request));
    response.setHeader('Set-Cookie', clearSessionCookie());
    return { ok: true };
  }

  @Get('me')
  async me(@Req() request: any) {
    const user = await this.authService.getUserForSession(getSessionIdFromRequest(request));
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    return user;
  }

  /**
   * How much life this session has left, and by which clock.
   *
   * A read, and only a read: it deliberately does not record activity, so a tab
   * polling it cannot keep an unattended browser signed in. That is what makes
   * the idle warning possible at all — the countdown has to be able to reach
   * zero while somebody is away from the keyboard.
   *
   * It carries no personal data: two timestamps, the policy's own durations and
   * the server's clock. The clock is the point — the client measures against
   * the clock that will actually decide, not against its own.
   */
  @Get('session')
  async session(@Req() request: any) {
    const status = await this.authService.getSessionStatus(getSessionIdFromRequest(request));
    if (!status) {
      throw new UnauthorizedException('Authentication required');
    }

    return status;
  }

  /**
   * Records activity, and returns the window that was just extended.
   *
   * Behind the "stay signed in" button and behind the throttled heartbeat real
   * interaction produces. It can only move the idle mark; the absolute expiry
   * is never rewritten, so no amount of calling this makes a session immortal.
   */
  @Post('session/touch')
  async touchSession(@Req() request: any) {
    const status = await this.authService.touchSession(getSessionIdFromRequest(request));
    if (!status) {
      throw new UnauthorizedException('Authentication required');
    }

    return status;
  }
}
