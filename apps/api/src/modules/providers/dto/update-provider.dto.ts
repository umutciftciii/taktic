import { ProviderProfileFieldsDto } from './create-provider.dto';

/**
 * The profile form. It does not carry the business registration: that is
 * written through `PUT /providers/me/business-registration`, which keeps its
 * own history (CMP-006 PR-C).
 */
export class UpdateProviderDto extends ProviderProfileFieldsDto {}
