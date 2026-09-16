import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  getContactDisclosure,
  getCurrentUser,
  type Category,
  type PublicReviewsPage,
  type ShowcaseFeedCard,
} from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { readCurrentDraft } from '../../../lib/request-drafts';
import { areaSentence } from '../../showcase-shelf';
import { RatingSummaryLine } from '../../review-stars';
import { faceFromFeedCard, ShowcaseCardFace } from '../../showcase-card-face';
import { ShowcaseLeadForm } from './lead-form';
import { readTurnstileWebConfig } from '../../../lib/turnstile';

type CardPageProps = {
  params: Promise<{ cardId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * One vitrin card: what it covers, and — if the customer is inside that
 * coverage — the form that writes to the business behind it.
 *
 * ## The screen is a decision before it is a form
 *
 * A visitor arrives here from a shelf they did not filter, so the first thing
 * this page owes them is the question "is this for me": the service area, the
 * scope, and the price, with a plain way to go on and a plain way to leave.
 * The form comes after that decision, not instead of it.
 *
 * ## Why an unavailable card is a 404
 *
 * A card whose run has ended, one an operator pulled, and one that never
 * existed all answer identically. A card is a business's price list, and a
 * distinguishable "this exists but is not published" would let anybody walk the
 * id space and read what competitors are about to advertise, and for how much.
 * The API makes that decision; this page only renders what it is given.
 *
 * ## Why the coverage shown here is not the coverage check
 *
 * It is an advertisement, not a gate. The customer types their real address
 * into the form below and the **server** decides whether this run serves it —
 * see `ShowcaseLeadService.createLead`. A page that pre-filtered the districts
 * would still be a page, and a page cannot stop a request.
 *
 * ## The form is the marketplace form's own parts
 *
 * Location, timing, description, contact and disclosure are the components the
 * category request form renders, fed here with the card's category and the
 * card's coverage. See `ShowcaseLeadForm` for why — in one sentence: a lead is
 * an ordinary request body, and building it from anything else is how a
 * free-text district ended up refused by the DTO and reported as a generic
 * failure.
 */
export default async function ShowcaseCardPublicPage({ params, searchParams }: CardPageProps) {
  const { cardId } = await params;
  const query = (await searchParams) ?? {};
  /*
   * No step at all is the scope panel: the decision comes before the form. Any
   * step name opens the form — the older `phone` / `code` / `form` steps were
   * separate screens once, and a link to one of them still lands on the form.
   */
  const showForm = readParam(query.step) !== null;
  const sent = readParam(query.sent) === '1';

  /*
   * A location the customer already chose somewhere else — on the marketplace
   * request form, where the vitrin cards for their own category and district
   * are offered. Carried so they are not asked the same question twice.
   *
   * It prefills and nothing more. The server re-resolves and re-checks it, so a
   * hand-edited query string buys nobody a lead outside the card's coverage.
   */
  const prefill = {
    city: readParam(query.city) ?? '',
    district: readParam(query.district) ?? '',
    neighborhood: readParam(query.neighborhood) ?? '',
    phone: readParam(query.phone) ?? '',
  };

  const card = await loadCard(cardId);
  if (!card) {
    notFound();
  }

  const [provinces, category, disclosure, user, draft, publicReviews] = await Promise.all([
    // The canonical province/district list, from the same API that validates a
    // submitted request — the list the marketplace form is built from.
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces').catch(
      () => [] as ProvinceWithDistricts[],
    ),
    // The card's category, for its questions: a lead has to answer what the
    // category requires, exactly as a marketplace request does, or the API
    // refuses it. A category the public endpoint will not serve leaves the
    // form with no questions rather than with no form.
    apiFetch<Category>(`/categories/${encodeURIComponent(card.category.slug)}`).catch(
      () => null,
    ),
    getContactDisclosure(),
    getCurrentUser(),
    // A form parked here before the customer left to sign in or activate an
    // account. `none` when there is nothing to restore; `wrong-account` when
    // the draft belongs to a different account than the one now signed in.
    // Keyed by the card too: a draft written for one business is not another's.
    readCurrentDraft({ formType: 'SHOWCASE_LEAD', categorySlug: card.category.slug, cardId }),
    // The business's public rating, from the same list the profile renders.
    // The API answers 404 while the switch is off, and null hides the line
    // entirely; a null *summary* on a 200 is "not enough yet" and is shown.
    // The card's own `provider.reviewSummary` cannot tell those two apart.
    loadPublicReviewSummary(card.provider.id),
  ]);

  const questions = category?.questions ?? [];
  const showDisclosure = disclosure.enabled && Boolean(disclosure.disclosureUrl);
  // The signed-in customer's own contact, for the form to show. Only a CUSTOMER
  // account has one — see the category page for why an admin is a visitor here.
  const accountContact =
    user?.role === 'CUSTOMER' ? { name: user.name, phone: user.phone, email: user.email } : null;

  const coverage = areaSentence(card);
  const nextStepHref = `/vitrin/${cardId}?step=form${locationQuery(prefill)}`;
  /*
   * This screen's own path for the form to hand to sign-in and activation as
   * `redirectTo`: the customer comes back to exactly this form, and the draft
   * saved before leaving is restored here. The prefill is left out on purpose
   * — the draft carries the location, and a telephone number has no place in
   * a URL that travels through an e-mail.
   */
  const formPath = `/vitrin/${cardId}?step=form`;

  return (
    <main className="lp-section">
      <div className="lp-container showcase-public">
        <nav className="pdash-crumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <Link href="/vitrin">Vitrin</Link>
          <span aria-hidden="true">/</span>
          <span>{card.title}</span>
        </nav>

        <header className="lp-section-head">
          <span className="kicker">{card.category.name}</span>
          <h1 className="lp-section-title">{card.title}</h1>
          {/*
            The business behind the card, as a link to its public page, and
            its public rating under it. This is the one vitrin surface where
            the threshold sentence is shown: a visitor deciding on this card
            should see that a rating is absent, not wonder whether the page
            forgot it. The shelf card says nothing below the threshold.
          */}
          <p className="lp-section-sub">
            <Link href={`/isletme/${card.provider.id}`} data-testid="showcase-card-provider-link">
              {card.provider.businessName}
            </Link>
          </p>
          {publicReviews ? (
            <RatingSummaryLine summary={publicReviews.summary} testId="showcase-card-review-summary" />
          ) : null}
        </header>

        <div className="vitrin-public">
          <div className="showcase-public-body">
            <ShowcaseCardFace
              // The business and its rating are in the header above; the face
              // on this page is the offer itself.
              card={{ ...faceFromFeedCard(card), providerName: null, reviewSummary: null }}
              testId="showcase-card-face"
              eager
              titleAs="h2"
            />

            <p className="showcase-coverage-note" data-testid="showcase-card-coverage-note">
              Bu hizmet yalnız {coverage} kapsamındaki işler için sunulur.
            </p>

            <div className="vitrin-summary-facts">
              <div>
                <h2>Dahil olanlar</h2>
                <ul className="showcase-list">
                  {card.scopeIncluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Hariç olanlar</h2>
                <ul className="showcase-list">
                  {card.scopeExcluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Yanıt taahhüdü</h2>
                <p>
                  Acil: {card.responseSlaUrgentHours} saat · Normal: {card.responseSlaNormalHours}{' '}
                  saat içinde dönüş
                </p>
              </div>
              <p className="muted">
                Bu işletme, hizmet bedelini ve kapsamını kendisi belirler ve müşterisinden kendisi
                tahsil eder. TakTick bu bedele taraf değildir.
              </p>
            </div>
          </div>

          {sent ? (
            <div className="notice" role="status" data-testid="showcase-lead-sent">
              Talebiniz {card.provider.businessName} işletmesine iletildi. Yanıt gelmezse size
              e-posta ile yazacağız ve talebinizi diğer hizmet verenlere açmak isteyip
              istemediğinizi soracağız.
            </div>
          ) : (
            <section className="showcase-public-cta" data-testid="showcase-lead-cta">
              <h2>Bu işletmeye talep gönderin</h2>
              <p className="muted">
                Talebiniz yalnız {card.provider.businessName} işletmesine iletilir. Başka hiçbir
                hizmet verene gönderilmez.
              </p>

              {showForm ? (
                <ShowcaseLeadForm
                  card={card}
                  cardId={cardId}
                  coverage={coverage}
                  provinces={provinces}
                  questions={questions}
                  disclosure={disclosure}
                  showDisclosure={showDisclosure}
                  accountContact={accountContact}
                  prefill={prefill}
                  turnstile={readTurnstileWebConfig()}
                  initialDraft={draft.kind === 'payload' ? draft.payload : null}
                  wrongAccount={draft.kind === 'wrong-account'}
                  formPath={formPath}
                />
              ) : (
                /*
                 * The decision, and both ways out of it.
                 *
                 * "Vazgeç" goes back to the shelf rather than to the browser's
                 * history, because somebody who arrived from a search result
                 * has no history to go back to and would otherwise be stranded
                 * on a card they have just declined.
                 */
                <div className="pdash-form-foot" data-testid="showcase-card-decision">
                  <Link className="pdash-btn pdash-btn-ghost" href="/vitrin">
                    Vazgeç
                  </Link>
                  <Link className="pdash-btn pdash-btn-primary" href={nextStepHref}>
                    Devam et
                  </Link>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/** The prefill, as a query-string fragment for the "Devam et" link. */
function locationQuery(prefill: {
  city: string;
  district: string;
  neighborhood: string;
  phone: string;
}): string {
  const params = new URLSearchParams();
  if (prefill.city) params.set('city', prefill.city);
  if (prefill.district) params.set('district', prefill.district);
  if (prefill.neighborhood) params.set('neighborhood', prefill.neighborhood);
  if (prefill.phone) params.set('phone', prefill.phone);
  const query = params.toString();
  return query ? `&${query}` : '';
}

async function loadPublicReviewSummary(providerId: string): Promise<PublicReviewsPage | null> {
  try {
    return await apiFetch<PublicReviewsPage>(
      `/providers/${encodeURIComponent(providerId)}/reviews/public?limit=1`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function loadCard(cardId: string): Promise<ShowcaseFeedCard | null> {
  try {
    return await apiFetch<ShowcaseFeedCard>(`/showcase/cards/${cardId}`);
  } catch {
    return null;
  }
}

function readParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
