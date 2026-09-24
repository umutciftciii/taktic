/**
 * The TakTick mark on its red tile (K15).
 *
 * The white mark is only ever drawn on the accent tile — on the page's light
 * ground it would disappear. The full-colour `/brand/logo.png` stays where it
 * was, untouched, for anything that still wants the whole wordmark.
 *
 * The image is decorative next to the "TakTick" text every caller prints, so
 * its alt is empty and the name is read once rather than twice.
 */
export function BrandMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span className={size === 'lg' ? 'brand-tile brand-tile-lg' : 'brand-tile'} aria-hidden="true">
      <img className="brand-tile-mark" src="/brand/mark-white.png" alt="" />
    </span>
  );
}
