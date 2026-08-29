import type { Question, RouterSelection } from '../../../lib/api';
import { encodeRouterSelections } from '../../../lib/request-flow';
import { resolveRouterStepAction } from '../actions';
import { IconArrowRight } from '../../landing-icons';

type RouterStepProps = {
  /** Where the whole flow began — never this router, once there are two. */
  entryCategorySlug: string;
  /** The steps already taken, replayed so the API can re-walk them. */
  selections: RouterSelection[];
  question: Question;
};

/**
 * The one screen a ROUTER category has: a question whose answer decides which
 * service the customer actually needs.
 *
 * There is no request form here and no "category" field to post. The browser
 * sends the option that was clicked; the API looks it up in the stored routing
 * rules and answers with the next screen — which may be another router, and is
 * eventually a leaf's own form. A customer who edits the URL reaches a
 * refusal, not a request filed against a service they never chose.
 */
export function RouterStep({ entryCategorySlug, selections, question }: RouterStepProps) {
  const options = question.options ?? [];

  return (
    <form action={resolveRouterStepAction} className="form-card" data-testid="router-step">
      <input type="hidden" name="entryCategorySlug" value={entryCategorySlug} />
      <input type="hidden" name="routerSelections" value={encodeRouterSelections(selections)} />
      <input type="hidden" name="routerQuestionKey" value={question.key} />

      <section className="form-section">
        <h2>{question.label}</h2>
        {question.helpText ? <p className="form-section-subtitle">{question.helpText}</p> : null}

        <label className="form-row">
          <span>Seçiminiz *</span>
          <select name="routerOptionKey" required defaultValue="" data-testid="router-option">
            <option value="">Seçiniz</option>
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="help-text">
            Seçiminize göre doğru hizmetin talep formuna yönlendirilirsiniz.
          </span>
        </label>
      </section>

      <div className="step-foot">
        <span className="muted" style={{ fontSize: 12 }}>
          * zorunlu alanlar
        </span>
        <button className="btn btn-primary" type="submit">
          Devam et
          <IconArrowRight />
        </button>
      </div>
    </form>
  );
}
