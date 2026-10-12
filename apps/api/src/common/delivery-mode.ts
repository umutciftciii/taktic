import { BadRequestException } from '@nestjs/common';
import { CategoryDeliveryModel, RequestDeliveryMode } from '@prisma/client';

/**
 * MATCH-001 — how a request's delivery mode is decided, the single definition.
 *
 * A category says how its service *can* be delivered (CategoryDeliveryModel);
 * a request says how *this* job is delivered (RequestDeliveryMode), and that
 * snapshot — not the category — is what location matching reads for the rest
 * of the request's life. The two meet exactly once, here, when a request is
 * created:
 *
 * - ON_SITE category → ON_SITE request,
 * - REMOTE category  → REMOTE request,
 * - HYBRID category  → the customer's choice, which is then required.
 *
 * A body that names a mode its category cannot take is refused rather than
 * corrected: a client that believes a service is remote when it is not is
 * showing the customer the wrong form, and silently matching the request
 * differently from what they were told would hide that. The
 * `ServiceRequest_delivery_mode_guard` trigger holds the same rule at the
 * database whatever the writer.
 */
export const DELIVERY_MODE_REQUIRED_CODE = 'DELIVERY_MODE_REQUIRED';
export const DELIVERY_MODE_MISMATCH_CODE = 'DELIVERY_MODE_MISMATCH';

export function resolveRequestDeliveryMode(
  categoryModel: CategoryDeliveryModel,
  requested: RequestDeliveryMode | null | undefined,
): RequestDeliveryMode {
  if (categoryModel === CategoryDeliveryModel.HYBRID) {
    if (!requested) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: DELIVERY_MODE_REQUIRED_CODE,
        message: 'Bu hizmet için yerinde mi uzaktan mı hizmet istediğinizi seçmelisiniz.',
      });
    }
    return requested;
  }

  const fixed =
    categoryModel === CategoryDeliveryModel.REMOTE ? RequestDeliveryMode.REMOTE : RequestDeliveryMode.ON_SITE;

  if (requested && requested !== fixed) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: DELIVERY_MODE_MISMATCH_CODE,
      message:
        fixed === RequestDeliveryMode.REMOTE
          ? 'Bu hizmet yalnız uzaktan verilir.'
          : 'Bu hizmet yalnız yerinde verilir.',
    });
  }

  return fixed;
}

/** Whether provider service areas are a matching criterion for this request at all. */
export function isLocationBound(request: { deliveryMode: RequestDeliveryMode }): boolean {
  return request.deliveryMode !== RequestDeliveryMode.REMOTE;
}

/**
 * Whether a provider bound to these categories needs a service area at all.
 *
 * A provider whose every category is REMOTE has no request that reads their
 * areas, so asking them for one would be a requirement nothing uses. Any
 * ON_SITE or HYBRID category — and an empty list, which is what an
 * incomplete application looks like — keeps the requirement exactly as it was.
 */
export function providerNeedsServiceArea(
  categories: ReadonlyArray<{ deliveryModel: CategoryDeliveryModel }>,
): boolean {
  return (
    categories.length === 0 ||
    categories.some((category) => category.deliveryModel !== CategoryDeliveryModel.REMOTE)
  );
}
