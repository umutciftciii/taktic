import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { OperationsSettingsService } from './operations-settings.service';
import { SaveOperationsSettingsDto } from './dto/save-operations-settings.dto';

/**
 * OPERATIONS_SETTINGS_READ and OPERATIONS_SETTINGS_WRITE, as two permissions.
 *
 * The refund window is a commercial term: it is printed on provider screens as
 * a promise and it decides what the refund worker pays out. Reading it is
 * restricted alongside writing it because this response also carries the audit
 * trail — who changed the platform's terms and when — which is not an
 * operations-staff fact.
 *
 * The narrowest correct access, not the widest defensible one: SUPER_ADMIN is
 * the only role this schema grants an operator, and no provider- or
 * customer-facing session reaches this controller at all. What a provider needs
 * — the sentence describing today's window — is served by
 * {@link RefundPolicyController}, which exposes the number and nothing else.
 */
@Controller('operations-settings')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class OperationsSettingsController {
  constructor(
    @Inject(OperationsSettingsService)
    private readonly operationsSettings: OperationsSettingsService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_READ)
  getOperationsSettings() {
    return this.operationsSettings.getForAdmin();
  }

  @Put()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_WRITE)
  saveOperationsSettings(@Body() dto: SaveOperationsSettingsDto, @CurrentUser() user: AuthUser) {
    // The audit row's operator is NOT NULL in the database, so an anonymous
    // save is refused here rather than failing halfway through the transaction.
    // AuthGuard already makes this unreachable; it stays because the audit
    // trail's value rests on it.
    if (!user?.id) {
      throw new ForbiddenException('Operations settings can only be changed by a signed-in admin');
    }

    return this.operationsSettings.save(dto, user.id);
  }
}
