import Link from 'next/link';
import { apiFetch, Category, getContactDisclosure, getCurrentUser } from '../../../lib/api';
import type { ProvinceWithDistricts } from '../../../lib/locations';
import { CategoryVisual } from '../../category-visual';
import { submitServiceRequestAction } from '../actions';
import { RequestForm } from './request-form';

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const [category, user, disclosure, provinces] = await Promise.all([
    apiFetch<Category>(`/categories/${slug}`),
    getCurrentUser(),
    getContactDisclosure(),
    // The canonical province/district list, from the same API that validates a
    // submitted request. Rendered with the form (~14 KB) so the first two
    // selects need no round trip.
    apiFetch<ProvinceWithDistricts[]>('/locations/provinces'),
  ]);
  const questions = category.questions ?? [];
  const showDisclosure = disclosure.enabled && Boolean(disclosure.disclosureUrl);

  return (
    <main className="req-page">
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
            <p className="page-subtitle">
              {category.description
                ? category.description
                : 'Soruları yanıtla, talebin ön incelemeden geçtikten sonra bölgendeki onaylı ustalara iletilir.'}
            </p>

            <div className="req-head-tags">
              <span className="tag tag-neutral">Kategoriye özel form</span>
              <span className="tag tag-neutral">14 gün geçerlilik</span>
              <span className="tag tag-accent">Teklif almak ücretsiz</span>
            </div>

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
        <RequestForm
          categorySlug={category.slug}
          questions={questions}
          disclosure={disclosure}
          showDisclosure={showDisclosure}
          provinces={provinces}
          action={submitServiceRequestAction}
        />
      </div>
    </main>
  );
}
