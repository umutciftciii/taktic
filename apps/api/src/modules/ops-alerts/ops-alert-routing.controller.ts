import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { ApplyCutoverDto, ApplyRevertDto } from './dto/ops-alert-recipient.dto';
import { withOpsAlertHttpErrors } from './ops-alert-http-errors';
import { OpsAlertKeyRotationService } from './ops-alert-key-rotation.service';
import { OpsAlertRoutingService } from './ops-alert-routing.service';

/**
 * OBS-ALERT-002 — where operations-alert e-mail goes (OPS_ALERT_EMAIL or the
 * managed recipients), and the recipient keys.
 *
 * Reading the state is a recipient reader's. Everything that changes it —
 * importing OPS_ALERT_EMAIL, the cutover and the revert (each a preview, then
 * an apply bound to the preview's token), re-wrapping and re-hashing — is
 * OPS_ALERT_ROUTING_MANAGE, reserved for SUPER_ADMIN: no role can carry it.
 */
@Controller('ops-alerts/routing')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class OpsAlertRoutingController {
  constructor(
    @Inject(OpsAlertRoutingService) private readonly routing: OpsAlertRoutingService,
    @Inject(OpsAlertKeyRotationService) private readonly rotation: OpsAlertKeyRotationService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_READ)
  state() {
    return withOpsAlertHttpErrors(() => this.routing.state());
  }

  @Post('import-env')
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  importFromEnv(@CurrentUser() user: AuthUser) {
    return withOpsAlertHttpErrors(() => this.routing.importFromEnv(user));
  }

  @Post('cutover/preview')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  previewCutover() {
    return withOpsAlertHttpErrors(() => this.routing.previewCutover());
  }

  @Post('cutover')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  applyCutover(@CurrentUser() user: AuthUser, @Body() dto: ApplyCutoverDto) {
    return withOpsAlertHttpErrors(() => this.routing.applyCutover(user, { token: dto.token }));
  }

  @Post('revert/preview')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  previewRevert() {
    return withOpsAlertHttpErrors(() => this.routing.previewRevert());
  }

  @Post('revert')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  applyRevert(@CurrentUser() user: AuthUser, @Body() dto: ApplyRevertDto) {
    return withOpsAlertHttpErrors(() =>
      this.routing.applyRevert(user, { token: dto.token, cancelUnmatched: dto.cancelUnmatched === true }),
    );
  }

  @Post('rewrap')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  rewrap(@CurrentUser() user: AuthUser) {
    return withOpsAlertHttpErrors(() => this.rotation.rewrap(user));
  }

  @Post('rehash')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_ROUTING_MANAGE)
  rehash(@CurrentUser() user: AuthUser) {
    return withOpsAlertHttpErrors(() => this.rotation.rehash(user));
  }
}
