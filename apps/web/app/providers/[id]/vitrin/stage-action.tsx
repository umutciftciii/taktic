import Link from 'next/link';
import { submitShowcaseCardAction, useShowcaseEntitlementAction } from './actions';
import type { ShowcaseStage } from './showcase-stage';

/**
 * The one primary action a card offers, as a link or a one-button form.
 *
 * A stage with nothing to do renders nothing — not a disabled button. The hub
 * and the card screen both draw this, so the two can never offer a different
 * next step for the same card.
 */
export function StageAction({
  stage,
  providerId,
  cardId,
}: {
  stage: ShowcaseStage;
  providerId: string;
  cardId: string;
}) {
  if (!stage.action) {
    return null;
  }
  if (stage.action.kind === 'link') {
    return (
      <Link className="pdash-btn pdash-btn-primary" href={stage.action.href} data-testid="showcase-stage-action">
        {stage.action.label}
      </Link>
    );
  }
  const action = stage.action.kind === 'submit' ? submitShowcaseCardAction : useShowcaseEntitlementAction;
  return (
    <form action={action}>
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="cardId" value={cardId} />
      <button className="pdash-btn pdash-btn-primary" type="submit" data-testid="showcase-stage-action">
        {stage.action.label}
      </button>
    </form>
  );
}
