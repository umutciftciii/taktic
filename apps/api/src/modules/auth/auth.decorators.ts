import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest();
  return request.user ?? null;
});
