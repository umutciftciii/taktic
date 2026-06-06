import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { CustomersService } from './customers.service';
import { CreateCustomerNoteDto } from './dto/create-customer-note.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerStatusDto } from './dto/update-customer-status.dto';

@Controller('customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customersService: CustomersService) {}

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  list(@Query() query: ListCustomersDto) {
    return this.customersService.list(query);
  }

  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  detail(@Param('id') id: string) {
    return this.customersService.detail(id);
  }

  @Get(':id/notes')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  listNotes(@Param('id') id: string) {
    return this.customersService.listNotes(id);
  }

  @Post(':id/notes')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  createNote(
    @Param('id') id: string,
    @Body() dto: CreateCustomerNoteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.customersService.createNote(id, dto, user.id);
  }

  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  updateStatus(@Param('id') id: string, @Body() dto: UpdateCustomerStatusDto) {
    return this.customersService.updateStatus(id, dto);
  }
}
