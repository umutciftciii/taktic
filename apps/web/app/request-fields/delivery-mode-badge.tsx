import { requestDeliveryMode } from '@taktic/shared';

/**
 * MATCH-001: "Uzaktan" next to a REMOTE request's place on a provider's
 * screens — the reason a request outside their service areas is in front of
 * them. Text, not colour; nothing at all for an ON_SITE request, so those
 * rows read exactly as they did.
 */
export function DeliveryModeBadge({ request }: { request: { deliveryMode?: string | null } }) {
  if (requestDeliveryMode(request) !== 'REMOTE') return null;
  return (
    <span className="tag tag-neutral" data-testid="delivery-mode-badge">
      Uzaktan
    </span>
  );
}
