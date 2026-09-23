import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import {
  ApprovePackageRefundRequestDto,
  CreatePackageRefundRequestDto,
  ListPackageRefundRequestsDto,
  PackageRefundReasonDto,
} from './dto/admin-package-refund.dto';
import { PackageRefundRequestsService } from './package-refund-requests.service';

/**
 * CMP-006 PR-B — the operator's refund queue.
 *
 * Read with PACKAGE_REFUND_READ; open and take (the maker side) with
 * PACKAGE_REFUND_REQUEST_CREATE; approve, reject and record a failed
 * settlement (the checker side) with PACKAGE_REFUND_APPROVE.
 *
 * Note what is not here: no route writes SETTLED ("the refund was done"). That
 * fact belongs to the signed `order_refunded` webhook alone, and the database
 * refuses it from anywhere else. There is no delete, and no route names a
 * provider or an owner — both come from the ticket.
 */
@Controller('admin/package-refund-requests')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminPackageRefundRequestsController {
  constructor(
    @Inject(PackageRefundRequestsService) private readonly requests: PackageRefundRequestsService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_READ)
  list(@Query() query: ListPackageRefundRequestsDto) {
    return this.requests.list(query);
  }

  @Get(':id')
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_READ)
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.requests.detail(id, user);
  }

  @Post()
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_REQUEST_CREATE)
  create(@Body() dto: CreatePackageRefundRequestDto, @CurrentUser() user: AuthUser) {
    return this.requests.createByAdmin(user, dto);
  }

  @Post(':id/take')
  @HttpCode(200)
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_REQUEST_CREATE)
  take(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.requests.take(id, user);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_APPROVE)
  approve(
    @Param('id') id: string,
    @Body() dto: ApprovePackageRefundRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.approve(id, user, dto);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_APPROVE)
  reject(@Param('id') id: string, @Body() dto: PackageRefundReasonDto, @CurrentUser() user: AuthUser) {
    return this.requests.reject(id, user, dto.reason);
  }

  @Post(':id/settlement-failed')
  @HttpCode(200)
  @RequiresPermission(AdminPermission.PACKAGE_REFUND_APPROVE)
  settlementFailed(
    @Param('id') id: string,
    @Body() dto: PackageRefundReasonDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.markSettlementFailed(id, user, dto.reason);
  }
}
