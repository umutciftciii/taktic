import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import {
  ApiError,
  apiFetch,
  Category,
  getContactDisclosure,
  getCurrentUser,
  getMarketplacePublishPolicy,
} from '../../../lib/api';
import { breadcrumbSchema, categoryServiceSchema } from '../../../lib/seo-json-ld';
import {
  SEO_DEFAULT_IMAGE,
  SEO_DESCRIPTION_MAX,
  privatePageMetadata,
  publicPageMetadata,
  seoText,
  structuredDataOrigin,
} from '../../../lib/seo-metadata';
import { JsonLd } from '../../json-ld';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { readCurrentDraft } from '../../../lib/request-drafts';
import { decodeRouterSelections } from '../../../lib/request-flow';
import { requestFormIntroText } from '../../../lib/request-next-steps';
import { CategoryVisual } from '../../category-visual';
import { submitServiceRequestAction } from '../actions';
import { RequestForm } from './request-form';
import { readTurnstileWebConfig } from '../../../lib/turnstile';
import { RouterStep } from './router-step';

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
  /**
   * `entry` and `r` carry a routed flow across screens: where the customer
   * started, and the options they picked getting here. Both are re-validated by
   * the API on every step and again at submission, so neither is authority —
   * they are how the browser remembers, not how the category is decided.
   */
  searchParams: Promise<{ entry?: string; r?: string }>;
};

/**
 * The category, or null for one the public may not reach — a draft, a closed
 * category, a group, or one that never existed. The API already answers 404
 * for all four, and the reason it does is the same one this page must not
 * undo: "you may not see it" and "it is not there" have to look identical
 * from outside. Cached per request so the metadata and the page share one
 * round trip.
 */
const loadCategory = cache(async (slug: string): Promise<Category | null> => {
  try {
    return await apiFetch<Category>(`/categories/${slug}`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403 || error.status === 400)) {
      return null;
    }
    throw error;
  }
});

/**
 * Indexable on the clean path only: `?entry=` and `?r=` are a routed flow in
 * progress, the same page mid-conversation, and are noindex. The description
 * is the operator's own text made safe for a snippet, with a plain fallback
 * when there is none.
 */
export async function generateMetadata({ params, searchParams }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = await loadCategory(slug);
  if (!category) {
    return privatePageMetadata('Sayfa bulunamadı');
  }

  return publicPageMetadata({
    route: '/categories/:slug',
    params: { slug: category.slug },
    title: category.name,
    description:
      seoText(category.description, SEO_DESCRIPTION_MAX) ??
      `${category.name} için talep oluşturun; bölgenizdeki onaylı hizmet verenlerden teklif alın.`,
    image: category.coverImageUrl ?? category.imageUrl ?? SEO_DEFAULT_IMAGE,
    searchParams: await searchParams,
  });
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const { slug } = await params;
  const { entry, r } = await searchParams;
  const structuredOrigin = structuredDataOrigin('/categories/:slug', { entry, r });
  // A router that arrives without an entry is itself the entry: it is the first
  // screen of its own flow. The same slug is what the form posts under and what
  // a draft is keyed by — see the hidden `categorySlug` field in the form.
  const entryCategorySlug = entry ?? slug;
  const [loaded, user, disclosure, provinces, draft, autoPublishEnabled] = await Promise.all([
    // A slug the public may not reach is a 404 page rather than an error
    // screen — see loadCategory.
    loadCategory(slug),
    getCurrentUser(),
    getContactDisclosure(),
    // The canonical province/district list, from the same API that validates a
    // submitted request. Rendered with the form (~14 KB) so the first two
    // selects need no round trip.
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
    // A form parked here before the customer left to sign in or activate an
    // account. `none` when there is nothing to restore; `wrong-account` when
    // the draft belongs to a different account than the one now signed in.
    // Keyed by the *entry* slug, because that is the slug the form posts and
    // the draft was saved under — in a routed flow it is not this leaf.
    readCurrentDraft({ formType: 'MARKETPLACE', categorySlug: entryCategorySlug }),
    // Whether providers see the request at once or an operator reads it first
    // — for the "Sırada ne var?" note and the sentence under the heading only.
    // Read fresh on every load, off on any failure; the API applies the real
    // rule when the request is posted.
    getMarketplacePublishPolicy(),
  ]);
  if (!loaded) {
    notFound();
  }
  const category = loaded;
  const questions = category.questions ?? [];
  const showDisclosure = disclosure.enabled && Boolean(disclosure.disclosureUrl);

  /*
   * The signed-in customer's own contact, for the form to show. Only a CUSTOMER
   * account has one: an admin posting on the public endpoint is treated as a
   * visitor by the API, so showing them an account contact would promise
   * something the server would not do.
   *
   * It is display only. Nothing here is posted, and the API reads the same three
   * values from the session's own User row when it stores the request.
   */
  const accountContact =
    user?.role === 'CUSTOMER'
      ? { name: user.name, phone: user.phone, email: user.email }
      : null;

  const isRouter = category.kind === 'ROUTER';
  const routerSelections = decodeRouterSelections(r);
  const routerQuestion = questions.find((question) => question.isRouter);

  /*
   * This screen's own path, with the routed-flow query kept, for the form to
   * hand to sign-in and activation as `redirectTo`: the customer comes back to
   * exactly this form, and the draft saved before leaving is restored here.
   */
  const formQuery = new URLSearchParams({ ...(entry ? { entry } : {}), ...(r ? { r } : {}) }).toString();
  const formPath = `/categories/${slug}${formQuery ? `?${formQuery}` : ''}`;

  return (
    <main className="req-page">
      <JsonLd data={structuredOrigin ? categoryServiceSchema(structuredOrigin, category) : null} />
      <JsonLd
        data={
          structuredOrigin
            ? breadcrumbSchema(structuredOrigin, [
                { name: 'Ana sayfa', path: '/' },
                { name: 'Kategoriler', path: '/categories' },
                { name: category.name },
              ])
            : null
        }
      />
      <section className="req-head">
        <div className="lp-container req-head-inner">
          <div className="req-head-text">
            <nav className="breadcrumbs" aria-label="Breadcrumb">
              <Link href="/categories">Kategoriler</Link>
              <span aria-hidden="true">/</span>
              <span>{category.name}</span>
            </nav>

            {/*
              The heading keeps the bare category name: the E2E suite and the
              customer both identify this screen by it.
            */}
            <h1 className="req-head-title">{category.name}</h1>
            {/*
              A category's own description wins. Without one, the sentence
              follows the instant-publish switch like the "Sırada ne var?" note
              below — it must not promise a review that will not happen.
            */}
            <p className="page-subtitle" data-testid="request-form-intro">
              {category.description ? category.description : requestFormIntroText(autoPublishEnabled)}
            </p>

            <div className="req-head-tags">
              <span className="tag tag-neutral">
                {isRouter ? 'Doğru hizmeti bulalım' : 'Kategoriye özel form'}
              </span>
              <span className="tag tag-neutral">14 gün geçerlilik</span>
              <span className="tag tag-accent">Teklif almak ücretsiz</span>
            </div>

            {isRouter ? null : (
              <div style={{ marginTop: 24 }}>
                {user?.role === 'CUSTOMER' ? (
                  <div className="notice">Bu talep müşteri hesabınıza bağlanacak.</div>
                ) : (
                  <div className="notice">
                    <span>
                      Misafir talep oluşturuyorsunuz. Hesap oluşturursanız taleplerinizi daha sonra
                      takip edebilirsiniz. <Link href="/register/customer">Hesap oluştur</Link>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="req-head-media">
            <CategoryVisual
              imageUrl={category.imageUrl ?? category.coverImageUrl}
              slug={category.slug}
              iconKey={category.iconKey}
              name={category.name}
              iconSize={48}
              alt=""
            />
          </div>
        </div>
      </section>

      <div className="lp-container">
        {isRouter ? (
          routerQuestion ? (
            <RouterStep
              entryCategorySlug={entryCategorySlug}
              selections={routerSelections}
              question={routerQuestion}
            />
          ) : (
            // A router with no routing question is a misconfiguration, not a
            // dead end for the customer: send them back to the catalogue rather
            // than to a form that cannot go anywhere.
            <div className="notice">
              Bu hizmet için yönlendirme henüz hazır değil.{' '}
              <Link href="/categories">Kategorilere dön</Link>
            </div>
          )
        ) : (
          <RequestForm
            categorySlug={category.slug}
            entryCategorySlug={entryCategorySlug}
            categoryId={category.id}
            routerSelections={routerSelections}
            questions={questions}
            disclosure={disclosure}
            showDisclosure={showDisclosure}
            provinces={provinces}
            accountContact={accountContact}
            action={submitServiceRequestAction}
            turnstile={readTurnstileWebConfig()}
            initialDraft={draft.kind === 'payload' ? draft.payload : null}
            wrongAccount={draft.kind === 'wrong-account'}
            formPath={formPath}
            autoPublishEnabled={autoPublishEnabled}
          />
        )}
      </div>
    </main>
  );
}
