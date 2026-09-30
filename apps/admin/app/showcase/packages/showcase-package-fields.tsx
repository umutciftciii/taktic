import { formatMinorAsTurkishLiraInput } from '@taktic/shared';
import type { ShowcasePackage } from '../../../lib/api';

/**
 * The pieces the vitrin catalogue's two screens share (ADMIN-DESIGN-001 Faz
 * 3F.1): the list's "Yeni paket" window and the package's own detail screen.
 * The same words, pattern and refusals on both, so creating a package and
 * editing one can never disagree about what a valid price is.
 */

export const SHOWCASE_PACKAGE_ERRORS: Record<string, string> = {
  SHOWCASE_PACKAGE_SLUG_INVALID:
    'Kısa ad "vitrin-" ile başlamak zorunda. Bu ön ek, ödeme sağlayıcısındaki ürün eşlemesinin teklif paketleriyle çakışmasını engeller.',
  SHOWCASE_PACKAGE_SLUG_TAKEN: 'Bu kısa ad başka bir vitrin paketinde kullanılıyor.',
  SHOWCASE_PACKAGE_NOT_FOUND: 'Vitrin paketi bulunamadı.',
  SHOWCASE_PACKAGE_PRICE_INVALID:
    'Yayın bedeli Türk lirası olarak girilmeli: örn. 10, 10,50 veya 1.250,75. Sıfır, eksi ve ikiden fazla ondalık kabul edilmez.',
  SHOWCASE_PACKAGE_SAVE_FAILED: 'Paket kaydedilemedi. Alanları kontrol edip tekrar deneyin.',
};

export function showcasePackageErrorText(code: string | undefined): string | null {
  if (!code) return null;
  return SHOWCASE_PACKAGE_ERRORS[code] ?? SHOWCASE_PACKAGE_ERRORS.SHOWCASE_PACKAGE_SAVE_FAILED!;
}

/**
 * The price field, as the operator sees it: lira, with a comma for kuruş.
 *
 * Kuruş are the storage unit and never the form's language. The field is a
 * text input rather than `type="number"` because a number input cannot hold
 * `1.250,75` — it reads the dot as a decimal point and the comma as a typo —
 * and `inputMode="decimal"` keeps the numeric keyboard on a phone. The server
 * action parses it with the shared helper; the pattern here only spares the
 * operator a round trip for the obvious cases.
 */
export const PRICE_HELP = 'Türk lirası. Kuruş için virgül kullanın: 10, 10,50 veya 1.250,75.';
export const PRICE_PATTERN = '([0-9]{1,3}(\\.[0-9]{3})*|[0-9]+)(,[0-9]{1,2})?';

export function PriceField({
  defaultValue,
  className,
  help = PRICE_HELP,
}: {
  defaultValue?: number;
  className?: string;
  help?: string;
}) {
  return (
    <label className={className}>
      <span>Yayın bedeli (₺) *</span>
      <input
        name="priceAmount"
        type="text"
        inputMode="decimal"
        required
        pattern={PRICE_PATTERN}
        placeholder="499,90"
        defaultValue={defaultValue === undefined ? '' : formatMinorAsTurkishLiraInput(defaultValue)}
        data-testid="showcase-package-price"
      />
      <small className="help-text">{help}</small>
    </label>
  );
}

/**
 * The catalogue's own listing order, and nothing else: it says where this
 * package sits in the shop's list, and nothing about where any card sits on
 * the home page. The vitrin shelf is ordered by the feed — one round of every
 * provider's best card, then a round of second cards — and no package, price
 * or setting moves a card up it. Stating that where the number is set is what
 * keeps an operator from selling a boost that does not exist.
 */
export const SORT_ORDER_HELP =
  'Yalnız paket listesindeki görünüm sırası (küçük sayı önce). Kartların ana sayfa veya vitrin sayfalarındaki sırasını etkilemez; hiçbir paket bir karta öncelik ya da sıralama avantajı vermez.';

export function cardKindText(pkg: Pick<ShowcasePackage, 'allowedCardKind'>, labels: Record<string, string>): string {
  return pkg.allowedCardKind ? (labels[pkg.allowedCardKind] ?? pkg.allowedCardKind) : 'Her ikisi';
}

export function areaText(pkg: Pick<ShowcasePackage, 'maxAreas'>): string {
  return pkg.maxAreas === null ? 'Tümü' : `En fazla ${pkg.maxAreas}`;
}
