import { Body, Controller, Get, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthThrottlerGuard } from '../auth/auth.throttler';
import { AuthUser } from '../auth/auth.types';
import { getSessionIdFromRequest } from '../auth/cookie';
import { RolesGuard } from '../auth/roles.guard';
import { AccountService } from './account.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateAccountProfileDto } from './dto/update-account-profile.dto';

/**
 * The signed-in person's own account.
 *
 * Every route here works on `user.id` taken from the session. None of them
 * accepts an account id — not in the path, not in the body — so there is no
 * request a caller can compose that reads or writes somebody else's profile.
 * That is deliberately a property of the routes rather than an ownership check
 * inside them: a check can be forgotten when a fourth route is added, a
 * missing parameter cannot.
 */
@Controller('account')
export class AccountController {
  constructor(@Inject(AccountService) private readonly accountService: AccountService) {}

  /**
   * Customer-only, like the screen it feeds. Providers edit their business
   * profile through /providers, and an operator's account is managed in the
   * admin panel; neither belongs on the customer settings screen, and neither
   * is silently given a second place to be edited from.
   */
  @Get('profile')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  getProfile(@CurrentUser() user: AuthUser) {
    return this.accountService.getProfile(user.id);
  }

  @Patch('profile')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateAccountProfileDto) {
    return this.accountService.updateProfile(user.id, dto);
  }

  /**
   * Open to every signed-in account, not just customers: a password belongs to
   * the person, not to the role, and there is nothing about changing one that
   * a provider or an operator should have to do somewhere else.
   *
   * Throttled like the other credential routes. This one takes a password and
   * says whether it was right, which makes it exactly the shape of endpoint an
   * attacker with a stolen session replays.
   */
  @Post('password')
  @UseGuards(AuthGuard, AuthThrottlerGuard)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: any,
  ) {
    // The session this request arrived on, so it can be the one left alive.
    return this.accountService.changePassword(user.id, dto, getSessionIdFromRequest(request));
  }
}
