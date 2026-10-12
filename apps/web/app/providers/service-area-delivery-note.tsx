import type { CategoryDeliveryModel } from '@taktic/shared';

type NoteCategory = { name: string; deliveryModel?: CategoryDeliveryModel | null };

/**
 * MATCH-001 — what a service area means for remote services, said next to the
 * area picker.
 *
 * A REMOTE service is matched without looking at areas at all, and a HYBRID
 * one only uses them for the requests a customer wants on site. A provider
 * whose every service is REMOTE needs no area (the API accepts an empty list
 * for them and nobody else). Nothing is rendered when the list has no remote
 * or hybrid service, so the form reads exactly as it did.
 */
export function ServiceAreaDeliveryNote({ categories }: { categories: readonly NoteCategory[] }) {
  const remote = categories.filter((category) => category.deliveryModel === 'REMOTE').map((c) => c.name);
  const hybrid = categories.filter((category) => category.deliveryModel === 'HYBRID').map((c) => c.name);
  if (remote.length === 0 && hybrid.length === 0) return null;

  return (
    <div className="pdash-form-hint service-area-delivery-note" data-testid="service-area-delivery-note">
      {remote.length > 0 ? (
        <p>
          <strong>Uzaktan sunulan hizmetler</strong> ({remote.join(', ')}): bu hizmetlerde bölge
          seçimi eşleşmeyi sınırlamaz; tüm ülkedeki talepleri görürsünüz. Yalnız uzaktan hizmetler
          seçtiyseniz bölge eklemeniz gerekmez.
        </p>
      ) : null}
      {hybrid.length > 0 ? (
        <p>
          <strong>Hibrit hizmetler</strong> ({hybrid.join(', ')}): bölgeleriniz yalnız müşterinin
          yerinde istediği taleplerde kullanılır; uzaktan istenen talepler bölgeden bağımsızdır.
        </p>
      ) : null}
    </div>
  );
}
