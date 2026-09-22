import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { CustomerActivationService } from '../customer-activation/customer-activation.service';
import { CustomersService } from './customers.service';
import { CreateCustomerNoteDto } from './dto/create-customer-note.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerStatusDto } from './dto/update-customer-status.dto';

@Controller('customers')
export class CustomersController {
  constructor(
    @Inject(CustomersService) private readonly customersService: CustomersService,
    @Inject(CustomerActivationService)
    private readonly activationService: CustomerActivationService,
  ) {}

  @Get()
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CUSTOMERS_READ)
  list(@Query() query: ListCustomersDto) {
    return this.customersService.list(query);
  }

  @Get(':id')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CUSTOMERS_READ)
  detail(@Param('id') id: string) {
    return this.customersService.detail(id);
  }

  @Get(':id/notes')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CUSTOMER_NOTES_READ)
  listNotes(@Param('id') id: string) {
    return this.customersService.listNotes(id);
  }

  @Post(':id/notes')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CUSTOMER_NOTES_WRITE)
  createNote(
    @Param('id') id: string,
    @Body() dto: CreateCustomerNoteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.customersService.createNote(id, dto, user.id);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CUSTOMERS_STATUS)
  updateStatus(@Param('id') id: string, @Body() dto: UpdateCustomerStatusDto) {
    return this.customersService.updateStatus(id, dto);
  }

  @Post(':id/activation-link')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.CUSTOMER_ACTIVATION_LINK_ISSUE)
  createActivationLink(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.activationService.createForCustomer(id, user.id);
  }
}
