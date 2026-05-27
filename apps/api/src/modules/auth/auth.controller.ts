import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { clearSessionCookie, getSessionIdFromRequest, sessionCookie } from './cookie';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await this.authService.login(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });

    response.setHeader('Set-Cookie', sessionCookie(result.sessionId, result.expiresAt));
    return result.user;
  }

  @Post('register-customer')
  async registerCustomer(
    @Body() dto: RegisterDto,
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const result = await this.authService.registerCustomer(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });

    response.setHeader('Set-Cookie', sessionCookie(result.sessionId, result.expiresAt));
    return result.user;
  }

  @Post('register-provider')
  async registerProvider(
    @Body() dto: RegisterDto,
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const result = await this.authService.registerProvider(dto, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    });

    response.setHeader('Set-Cookie', sessionCookie(result.sessionId, result.expiresAt));
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
}
