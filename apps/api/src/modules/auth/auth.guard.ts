import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { getSessionIdFromRequest } from './cookie';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const user = await this.authService.getUserForSession(getSessionIdFromRequest(request));

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    request.user = user;
    return true;
  }
}

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    request.user = await this.authService.getUserForSession(getSessionIdFromRequest(request));
    return true;
  }
}
