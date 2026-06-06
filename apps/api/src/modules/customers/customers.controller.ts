import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CustomersService } from './customers.service';
import { ListCustomersDto } from './dto/list-customers.dto';

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
}
