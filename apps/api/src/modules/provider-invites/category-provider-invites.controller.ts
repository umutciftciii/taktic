import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { ProviderInvitesService } from './provider-invites.service';

/**
 * The operator's half of the invitation flow.
 *
 * SUPER_ADMIN on every route with no optional path, unlike the category reads
 * these hang off: `GET /categories` serves everybody and widens for an operator,
 * because a catalogue has a public form. An invitation has none. Issuing one is
 * a decision about the unreleased catalogue, listing them names which
 * unreleased services are being staffed, and revoking one withdraws a
 * credential — there is no reading of any of the three that belongs to a
 * customer, a provider or an anonymous caller.
 *
 * Mounted under the category rather than at a top level because an invitation
 * has no meaning apart from the service it names: the id in the path is what
 * the operator is administering, and it scopes every row the routes can reach.
 */
@Controller('categories/:categoryId/provider-invites')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class CategoryProviderInvitesController {
  constructor(
    @Inject(ProviderInvitesService) private readonly invites: ProviderInvitesService,
  ) {}

  @Get()
  list(@Param('categoryId') categoryId: string) {
    return this.invites.listForCategory(categoryId);
  }

  /**
   * Issues a link. **This is the only response in the system that contains a
   * raw token**, and it contains it exactly once — no later read of this
   * invitation, by anybody, can produce it again.
   */
  @Post()
  issue(@Param('categoryId') categoryId: string, @CurrentUser() actor: AuthUser) {
    return this.invites.issueForCategory(categoryId, actor);
  }

  /**
   * Withdraws a link.
   *
   * A POST to a sub-resource rather than a DELETE on the invitation, because
   * the row is not deleted: an invitation that was issued and then withdrawn is
   * a thing that happened, and the list is the record of it.
   */
  @Post(':inviteId/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(@Param('categoryId') categoryId: string, @Param('inviteId') inviteId: string) {
    return this.invites.revoke(categoryId, inviteId);
  }
}
