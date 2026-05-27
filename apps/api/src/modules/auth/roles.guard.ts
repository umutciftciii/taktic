import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from './auth.decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!roles || roles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    if (!request.user || !roles.includes(request.user.role)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
