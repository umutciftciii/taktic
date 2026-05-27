import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProviderAccessGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const providerId = request.params.providerId ?? request.params.id;

    if (!user || !providerId) {
      throw new ForbiddenException('Provider access denied');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException('Provider access denied');
    }

    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { userId: true },
    });

    if (!provider || provider.userId !== user.id) {
      throw new ForbiddenException('Provider access denied');
    }

    return true;
  }
}
