import {
  Body,
  Controller,
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
import { ShowcaseFallbackDecisionDto } from './dto/showcase-lead.dto';
import { ShowcaseLeadService } from './showcase-lead.service';

/**
 * The customer's answer after their vitrin lead's deadline passed.
 *
 * ## Why the path is on `/service-requests`
 *
 * The thing being decided about is **their request**: it sits in their request
 * list, the mail links to it, and the decision changes that request's
 * visibility. A `/showcase/...` path would ask a customer to reason about
 * placements, which is a concept they have no use for and were never shown.
 *
 * ## Why the controller is in the vitrin module rather than beside the other
 * `/service-requests` routes
 *
 * Because a route's path and a route's module are different questions, and
 * Nest only cares about the decorator. Declaring it in `ServiceRequestsModule`
 * would mean that module depending on `ShowcaseLeadService` — which creates
 * requests through `ServiceRequestsService` — and the two would be mutually
 * dependent for the sake of one endpoint. The dependency that matters here runs
 * one way: this decision reads and writes a lead, and closing a lead as part of
 * a request's own lifecycle is somewhere else entirely
 * (`ShowcaseLeadLifecycleService`).
 *
 * ## Why a session is required
 *
 * Every other route in the vitrin customer flow is open to an anonymous
 * visitor. This one is not, and deliberately: releasing a request to the whole
 * market is irreversible, and a link that could do it by being clicked would be
 * a decision made by whoever the mail was forwarded to.
 *
 * The service answers with the same 404 for "no such request", "not yours" and
 * "not a vitrin lead" — a customer probing request ids must not learn which
 * ones are real.
 */
@Controller('service-requests')
export class ShowcaseFallbackController {
  constructor(@Inject(ShowcaseLeadService) private readonly leads: ShowcaseLeadService) {}

  @Post(':id/showcase-fallback')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ShowcaseFallbackDecisionDto,
  ) {
    return this.leads.decideFallback(id, user, dto);
  }
}
