import Link from 'next/link';
import type { OfferListResponse } from '../../lib/api';

type OfferPinsProps = {
  providerId: string;
  requestId: string;
  context: OfferListResponse['context'];
  unpinProviderHref: string;
  unpinRequestHref: string;
};

/**
 * The offer list's pins: the provider and the request the list is narrowed to.
 *
 * Named from the API's `context`, never from a row of the page
 * (ADMIN-PINNED-LABEL-001): a refund filter that matched nothing, or a page
 * past the last, used to leave the pin with its raw id. Only a pin the API
 * could not name — no offer behind it, or an unknown id — shows the id.
 */
export function OfferPins({ providerId, requestId, context, unpinProviderHref, unpinRequestHref }: OfferPinsProps) {
  if (!providerId && !requestId) return null;
  const provider = providerId && context.provider?.id === providerId ? context.provider : null;
  const request = requestId && context.request?.id === requestId ? context.request : null;

  return (
    <div className="admin-filter-pins" data-testid="offer-pins">
      {providerId ? (
        <span className="badge badge-muted" data-testid="offer-pin-provider">
          HV: {provider ? provider.businessName : <code className="cell-break">{providerId}</code>}{' '}
          <Link className="cell-link" href={unpinProviderHref} aria-label="Hizmet veren sabitlemesini kaldır">
            ×
          </Link>
        </span>
      ) : null}
      {requestId ? (
        <span className="badge badge-muted" data-testid="offer-pin-request">
          Talep:{' '}
          {request ? (
            <>
              {request.category.name} · {request.city}/{request.district}
            </>
          ) : (
            <code className="cell-break">{requestId}</code>
          )}{' '}
          <Link className="cell-link" href={unpinRequestHref} aria-label="Talep sabitlemesini kaldır">
            ×
          </Link>
        </span>
      ) : null}
    </div>
  );
}
