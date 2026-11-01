import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AuditPageQueryDto } from '../../common/admin-audit';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import {
  CreateOpsAlertRecipientDto,
  DeleteOpsAlertRecipientDto,
  PauseOpsAlertRecipientDto,
  ReplaceOpsAlertRecipientAddressDto,
  ResumeOpsAlertRecipientDto,
  UpdateOpsAlertRecipientDto,
} from './dto/ops-alert-recipient.dto';
import { withOpsAlertHttpErrors } from './ops-alert-http-errors';
import { OpsAlertRecipientsService } from './ops-alert-recipients.service';

/**
 * OBS-ALERT-002 — the operations-alert e-mail recipients (admin > Sistem
 * Sağlığı > Operasyon Alarmları > Bildirim Ayarları).
 *
 * Each verb is its own permission: READ lists (masked addresses only) and the
 * history, WRITE adds and edits, DELETE removes, REVEAL shows one address in
 * full (audited every time, never cached), TEST sends one test e-mail.
 * Replacing an address deletes the old recipient, so it takes WRITE and
 * DELETE together (PermissionsGuard is conjunctive).
 *
 * Request bodies are never logged; the services' refusals become 409/404/429
 * with a stable code (ops-alert-http-errors.ts).
 */
@Controller('ops-alerts/recipients')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class OpsAlertRecipientsController {
  constructor(@Inject(OpsAlertRecipientsService) private readonly recipients: OpsAlertRecipientsService) {}

  @Get()
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_READ)
  list() {
    return withOpsAlertHttpErrors(() => this.recipients.list());
  }

  @Post()
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOpsAlertRecipientDto) {
    return withOpsAlertHttpErrors(() =>
      this.recipients.create(user, {
        address: dto.address,
        label: dto.label,
        notifyWarning: dto.notifyWarning,
        notifyCritical: dto.notifyCritical,
        notifyRecovery: dto.notifyRecovery,
      }),
    );
  }

  /** Every recipient's history and the routing events, newest first. Declared before `:id`. */
  @Get('audit')
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_READ)
  auditAll(@Query() query: AuditPageQueryDto, @CurrentUser() user: AuthUser) {
    return withOpsAlertHttpErrors(() => this.recipients.auditPage(null, query, user));
  }

  @Patch(':id')
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateOpsAlertRecipientDto) {
    return withOpsAlertHttpErrors(() =>
      this.recipients.update(user, id, {
        version: dto.version,
        label: dto.label,
        notifyWarning: dto.notifyWarning,
        notifyCritical: dto.notifyCritical,
        notifyRecovery: dto.notifyRecovery,
        confirmLastCritical: dto.confirmLastCritical,
      }),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DeleteOpsAlertRecipientDto) {
    await withOpsAlertHttpErrors(() =>
      this.recipients.remove(user, id, { version: dto.version, reason: dto.reason, confirmLastCritical: dto.confirmLastCritical }),
    );
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_WRITE)
  pause(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PauseOpsAlertRecipientDto) {
    return withOpsAlertHttpErrors(() =>
      this.recipients.pause(user, id, { version: dto.version, confirmLastCritical: dto.confirmLastCritical }),
    );
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_WRITE)
  resume(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ResumeOpsAlertRecipientDto) {
    return withOpsAlertHttpErrors(() => this.recipients.resume(user, id, { version: dto.version }));
  }

  @Post(':id/replace-address')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_WRITE, AdminPermission.OPS_ALERT_RECIPIENTS_DELETE)
  replaceAddress(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplaceOpsAlertRecipientAddressDto) {
    return withOpsAlertHttpErrors(() =>
      this.recipients.replaceAddress(user, id, { version: dto.version, address: dto.address, reason: dto.reason }),
    );
  }

  /** The one response that carries an address in full: audited, and never stored by a cache. */
  @Post(':id/reveal')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_REVEAL)
  reveal(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return withOpsAlertHttpErrors(() => this.recipients.reveal(user, id));
  }

  /** One test e-mail now; 429 past one a minute per recipient or ten an hour in all. */
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_TEST)
  sendTest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return withOpsAlertHttpErrors(() => this.recipients.sendTest(user, id));
  }

  @Get(':id/audit')
  @RequiresPermission(AdminPermission.OPS_ALERT_RECIPIENTS_READ)
  audit(@Param('id') id: string, @Query() query: AuditPageQueryDto, @CurrentUser() user: AuthUser) {
    return withOpsAlertHttpErrors(() => this.recipients.auditPage(id, query, user));
  }
}
