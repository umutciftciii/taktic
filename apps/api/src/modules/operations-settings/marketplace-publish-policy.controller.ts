import { Controller, Get, Inject } from '@nestjs/common';
import { MarketplacePublishSettingsService } from './marketplace-publish-settings.service';

/**
 * The instant-publish switch as a public fact, and nothing else.
 *
 * The request form tells a customer what happens after they send a request —
 * whether an operator reads it first or providers see it at once — and that
 * sentence is shown before any session exists, so the endpoint is
 * unauthenticated. What it exposes is one boolean. It carries no change
 * history, no operator and no other operations setting, which is what keeps it
 * a separate controller rather than a relaxed version of the admin one at
 * `operations-settings/marketplace-publish`.
 *
 * It reads the switch through the same method the request path reads it with,
 * so the sentence a customer is shown and the state their request is created
 * in cannot disagree — and it inherits that method's rule that a missing or
 * unreadable row means "off".
 */
@Controller('marketplace-publish-policy')
export class MarketplacePublishPolicyController {
  constructor(
    @Inject(MarketplacePublishSettingsService)
    private readonly settings: MarketplacePublishSettingsService,
  ) {}

  @Get()
  async getPolicy() {
    return { autoPublishEnabled: await this.settings.isAutoPublishEnabled() };
  }
}
