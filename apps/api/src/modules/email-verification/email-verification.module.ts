import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EmailVerificationService } from './email-verification.service';

/**
 * Deliberately no controller and no dependency on AuthModule.
 *
 * Registration has to issue a verification link, which would make AuthModule
 * depend on this one; the verification routes need the session guard, which
 * would make this one depend on AuthModule. Rather than tie the two together
 * with forwardRef, the service lives here on its own and
 * {@link import('../auth/email-verification.controller').EmailVerificationController}
 * is declared by AuthModule, where the guards it needs already are. The same
 * arrangement CustomerActivationModule uses.
 */
@Module({
  imports: [PrismaModule],
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}
