import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { CreateProviderReviewDto } from './dto/create-provider-review.dto';
import { ProviderReviewsService } from './provider-reviews.service';

/**
 * Two segments after `/service-requests`, so `ServiceRequestsController`'s
 * `GET :id` never captures it regardless of module order.
 */
@Controller('service-requests/:id/review')
export class CustomerProviderReviewsController {
  constructor(@Inject(ProviderReviewsService) private readonly reviews: ProviderReviewsService) {}

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  create(
    @Param('id') id: string,
    @Body() dto: CreateProviderReviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviews.createForCustomer(id, user, dto);
  }

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reviews.getForCustomer(id, user);
  }
}
