import Link from 'next/link';
import { apiFetch, Category, getContactDisclosure, getCurrentUser, Question } from '../../../lib/api';
import { CategoryCover } from '../../category-visual';
import { submitServiceRequestAction } from '../actions';

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const [category, user, disclosure] = await Promise.all([
    apiFetch<Category>(`/categories/${slug}`),
    getCurrentUser(),
    getContactDisclosure(),
  ]);
  const questions = category.questions ?? [];
  const showDisclosure = disclosure.enabled && Boolean(disclosure.disclosureUrl);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Ana sayfa</Link>
        <span aria-hidden="true">/</span>
        <Link href="/categories">Kategoriler</Link>
        <span aria-hidden="true">/</span>
        <span>{category.name}</span>
      </p>

      {category.coverImageUrl ? (
        <div className="cat-detail-cover page-narrow">
          <CategoryCover
            coverImageUrl={category.coverImageUrl}
            alt={`${category.name} kapak görseli`}
            className="cat-detail-cover-img"
          />
        </div>
      ) : null}

      <header className="page-header page-narrow">
        <h1 className="page-title">{category.name}</h1>
        {category.description ? <p className="page-subtitle">{category.description}</p> : null}
      </header>

      <div className="page-narrow" style={{ marginBottom: 18 }}>
        {user?.role === 'CUSTOMER' ? (
          <div className="notice">Bu talep müşteri hesabınıza bağlanacak.</div>
        ) : (
          <div className="notice">
            Misafir talep oluşturuyorsunuz. Hesap oluşturursanız taleplerinizi daha sonra takip edebilirsiniz.{' '}
            <Link href="/register/customer">Hesap oluştur</Link>
          </div>
        )}
      </div>

      <form action={submitServiceRequestAction} className="form-card">
        <input type="hidden" name="categorySlug" value={category.slug} />
        <input
          type="hidden"
          name="questionMeta"
          value={JSON.stringify(questions.map((question) => ({ key: question.key, type: question.type })))}
        />

        {questions.length > 0 ? (
          <section className="form-section">
            <h2>Talep Detayları</h2>
            <p className="form-section-subtitle">Hizmet verenlerin doğru teklif verebilmesi için soruları yanıtlayın.</p>
            {questions.map((question) => (
              <RequestField key={question.id} question={question} />
            ))}
          </section>
        ) : null}

        <section className="form-section">
          <h2>İletişim ve Konum</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>Ad soyad *</span>
              <input name="customerName" required />
            </label>
            <label className="form-row">
              <span>Telefon *</span>
              <input name="customerPhone" required placeholder="05XX XXX XX XX" />
            </label>
          </div>
          <label className="form-row">
            <span>E-posta *</span>
            <input
              name="customerEmail"
              type="email"
              required
              placeholder="ornek@eposta.com"
            />
            <span className="help-text">
              Tekliflerinizi takip edebilmeniz için e-posta adresiniz gereklidir.
            </span>
          </label>
          <div className="form-grid">
            <label className="form-row">
              <span>İl *</span>
              <input name="city" required />
            </label>
            <label className="form-row">
              <span>İlçe *</span>
              <input name="district" required />
            </label>
            <label className="form-row">
              <span>Mahalle</span>
              <input name="neighborhood" />
            </label>
          </div>
          <label className="form-row">
            <span>Adres notu</span>
            <textarea name="addressNote" placeholder="Ek bilgi / yol tarifi" />
          </label>
        </section>

        <section className="form-section">
          <h2>Bütçe ve Zaman</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>Minimum bütçe</span>
              <input
                name="budgetMin"
                type="number"
                step="0.01"
                min="1"
                inputMode="decimal"
                placeholder="Örn. 1500.00"
              />
              <small style={{ color: 'var(--muted)', fontSize: 12 }}>
                İsteğe bağlı. Boş bırakırsanız bütçe sınırı belirtmemiş olursunuz. Ondalıklı tutar
                girebilirsiniz.
              </small>
            </label>
            <label className="form-row">
              <span>Maksimum bütçe</span>
              <input
                name="budgetMax"
                type="number"
                step="0.01"
                min="1"
                inputMode="decimal"
                placeholder="Örn. 3000.00"
              />
              <small style={{ color: 'var(--muted)', fontSize: 12 }}>
                İsteğe bağlı. Boş bırakabilirsiniz.
              </small>
            </label>
            <label className="form-row">
              <span>Tercih edilen tarih</span>
              <input name="preferredDate" type="date" />
            </label>
            <label className="form-row">
              <span>Aciliyet</span>
              <select name="urgency" defaultValue="">
                <option value="">Seçiniz</option>
                <option value="TODAY">Bugün</option>
                <option value="THIS_WEEK">Bu hafta</option>
                <option value="FLEXIBLE">Esnek</option>
              </select>
            </label>
          </div>
          <label className="form-row">
            <span>Açıklama</span>
            <textarea name="description" placeholder="Hizmet verenlere iletmek istediğiniz ek detaylar" />
          </label>
        </section>

        {showDisclosure ? (
          <section className="form-section">
            <h2>Bilgilendirme</h2>
            {/*
              The checkbox states one thing only: that the linked text was read.
              It does not paraphrase, summarise or stand in for that text — the
              disclosure itself lives at CONTACT_DISCLOSURE_URL, and the feature
              cannot be switched on until it does.
            */}
            <input
              type="hidden"
              name="contactDisclosureVersion"
              value={disclosure.disclosureVersion ?? ''}
            />
            <label className="checkbox-row" htmlFor="contact-disclosure">
              <input
                id="contact-disclosure"
                name="contactDisclosureAccepted"
                type="checkbox"
                value="true"
                required
                data-testid="contact-disclosure-accept"
              />
              <span>
                <a
                  href={disclosure.disclosureUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="contact-disclosure-link"
                >
                  İletişim bilgilerinin paylaşılmasına ilişkin bilgilendirme metnini
                </a>{' '}
                okudum.
              </span>
            </label>
          </section>
        ) : null}

        <div className="form-actions page-narrow" style={{ borderTop: 0, paddingTop: 0 }}>
          <button className="btn btn-primary" type="submit">Talebi Gönder</button>
          <Link className="btn btn-secondary" href="/categories">Vazgeç</Link>
          <span className="muted">* zorunlu alanlar</span>
        </div>
      </form>
    </main>
  );
}

function RequestField({ question }: { question: Question }) {
  return (
    <label className="form-row">
      <span>
        {question.label}
        {question.isRequired ? ' *' : ''}
      </span>
      {renderInput(question)}
      {question.helpText ? <span className="help-text">{question.helpText}</span> : null}
    </label>
  );
}

function renderInput(question: Question) {
  const name = `answer_${question.key}`;

  switch (question.type) {
    case 'TEXT':
      return <input name={name} required={question.isRequired} />;
    case 'TEXTAREA':
      return <textarea name={name} required={question.isRequired} />;
    case 'SELECT':
      return (
        <select name={name} required={question.isRequired} defaultValue="">
          <option value="">Seçiniz</option>
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'MULTI_SELECT':
      return (
        <select name={name} multiple required={question.isRequired}>
          {(question.options ?? []).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'NUMBER':
      return <input name={name} type="number" required={question.isRequired} />;
    case 'BOOLEAN':
      return (
        <span className="checkbox-row">
          <input name={name} type="checkbox" value="true" />
          <span>Evet</span>
        </span>
      );
    case 'DATE':
      return <input name={name} type="date" required={question.isRequired} />;
    case 'IMAGE':
      return <input name={name} placeholder="Dosya yükleme sonraki fazda" required={question.isRequired} />;
  }
}
