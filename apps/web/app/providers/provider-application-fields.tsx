import type { ReactNode } from 'react';
import type { ProvinceWithDistricts } from '../../lib/locations';
import { CityDistrictFields } from './city-district-fields';

type ProviderApplicationFieldsProps = {
  /** Every province with its districts, loaded by the page from the API. */
  provinces: ProvinceWithDistricts[];
  /**
   * Whether the contact address is mandatory. True whenever the application
   * will have no owning account and the claim flow is on — the link mailed to
   * that address is then the only thing that can ever hand the application back
   * to whoever submitted it.
   */
  emailRequired: boolean;
  /**
   * Section 04. The two forms differ here and nowhere else: the open form lets
   * an applicant tick the services they want, and the invited one states the
   * single service the invitation named, because that binding is the server's
   * to derive and not the applicant's to choose.
   */
  serviceScope: ReactNode;
};

/**
 * The provider application form, minus the one section the two callers differ
 * on.
 *
 * Extracted rather than copied when the invitation flow gained a second form.
 * Two hand-maintained copies of a form whose field names are the API contract
 * is how one of them quietly stops sending `serviceAreaNeighborhood`, or asks
 * for a district the address validator will refuse — and the applicant finds
 * out as a 400 with no field attached to it. One component means the invited
 * form cannot drift from the form this marketplace has been taking applications
 * with all along.
 *
 * Nothing here validates anything. Every rule these fields exist to satisfy —
 * that the province and district are a real pair, that at least one service
 * area is given, that a guest application carries a reachable address — is
 * enforced by the API against the stored data, and is enforced identically for
 * both forms because both go through ProvidersService.prepareApplication.
 */
export function ProviderApplicationFields({
  provinces,
  emailRequired,
  serviceScope,
}: ProviderApplicationFieldsProps) {
  return (
    <>
      <section className="provider-apply-card">
        <div className="provider-apply-card-head">
          <h2 className="provider-apply-card-title">
            <span className="provider-apply-card-num">01</span>
            İşletme bilgileri
          </h2>
          <p className="provider-apply-card-subtitle">İşletmenizi tanıtacak temel bilgiler.</p>
        </div>
        <div className="provider-apply-grid">
          <label className="provider-apply-field">
            <span className="provider-apply-label">
              İşletme adı <span className="provider-apply-required">*</span>
            </span>
            <input
              className="provider-apply-input"
              name="businessName"
              required
              placeholder="Örn. Yıldız Klima"
            />
          </label>
          <label className="provider-apply-field">
            <span className="provider-apply-label">
              Yetkili kişi <span className="provider-apply-required">*</span>
            </span>
            <input
              className="provider-apply-input"
              name="contactName"
              required
              placeholder="Ad Soyad"
            />
          </label>
          <label className="provider-apply-field provider-apply-field-full">
            <span className="provider-apply-label">Açıklama</span>
            <textarea
              className="provider-apply-textarea"
              name="description"
              placeholder="Müşterilerinize işletmenizden kısaca bahsedin."
            />
          </label>
        </div>
      </section>

      <section className="provider-apply-card">
        <div className="provider-apply-card-head">
          <h2 className="provider-apply-card-title">
            <span className="provider-apply-card-num">02</span>
            İletişim
          </h2>
          <p className="provider-apply-card-subtitle">
            Onay ve talep bildirimleri bu bilgilere gider.
          </p>
        </div>
        <div className="provider-apply-grid">
          <label className="provider-apply-field">
            <span className="provider-apply-label">
              Telefon <span className="provider-apply-required">*</span>
            </span>
            <input
              className="provider-apply-input"
              name="phone"
              required
              placeholder="05XX XXX XX XX"
            />
          </label>
          <label className="provider-apply-field">
            <span className="provider-apply-label">
              E-posta{' '}
              {emailRequired ? <span className="provider-apply-required">*</span> : null}
            </span>
            <input
              className="provider-apply-input"
              name="email"
              type="email"
              required={emailRequired}
              placeholder="ornek@firma.com"
            />
            {emailRequired ? (
              <span className="provider-apply-help">
                Başvuruyu hesabınıza bağlayan bağlantıyı bu adrese göndereceğiz.
              </span>
            ) : null}
          </label>
        </div>
      </section>

      <section className="provider-apply-card">
        <div className="provider-apply-card-head">
          <h2 className="provider-apply-card-title">
            <span className="provider-apply-card-num">03</span>
            Adres
          </h2>
          <p className="provider-apply-card-subtitle">İşletmenin merkez adresi.</p>
        </div>
        <div className="provider-apply-grid">
          <CityDistrictFields
            provinces={provinces}
            cityName="city"
            districtName="district"
            labels={{
              city: (
                <>
                  İl <span className="provider-apply-required">*</span>
                </>
              ),
              district: (
                <>
                  İlçe <span className="provider-apply-required">*</span>
                </>
              ),
            }}
            classNames={{
              field: 'provider-apply-field',
              label: 'provider-apply-label',
              select: 'sel',
            }}
          />
          <label className="provider-apply-field provider-apply-field-full">
            <span className="provider-apply-label">Adres notu</span>
            <textarea
              className="provider-apply-textarea"
              name="addressNote"
              placeholder="Müşterilerin sizi bulması için ek bilgi"
            />
          </label>
        </div>
      </section>

      {serviceScope}

      <section className="provider-apply-card">
        <div className="provider-apply-card-head">
          <h2 className="provider-apply-card-title">
            <span className="provider-apply-card-num">05</span>
            Hizmet bölgesi
          </h2>
          <p className="provider-apply-card-subtitle">
            İlk hizmet vermek istediğiniz bölgeyi belirtin. Onay sonrası genişletebilirsiniz.
          </p>
        </div>
        <div className="provider-apply-grid-3">
          {/*
            The district stays optional here, unlike the address above: a
            service area with no district means the whole province, which
            is what `matchesProviderArea` reads a null district as. Making
            it mandatory would quietly take province-wide coverage away
            from anyone who wanted it.
          */}
          <CityDistrictFields
            provinces={provinces}
            cityName="serviceAreaCity"
            districtName="serviceAreaDistrict"
            districtRequired={false}
            districtPlaceholder="Tüm il"
            labels={{
              city: (
                <>
                  İl <span className="provider-apply-required">*</span>
                </>
              ),
              district: 'İlçe',
            }}
            classNames={{
              field: 'provider-apply-field',
              label: 'provider-apply-label',
              select: 'sel',
            }}
          />
          <label className="provider-apply-field">
            <span className="provider-apply-label">Mahalle</span>
            <input className="provider-apply-input" name="serviceAreaNeighborhood" />
          </label>
        </div>
      </section>
    </>
  );
}
