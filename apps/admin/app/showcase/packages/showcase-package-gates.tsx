'use client';

import { formatMinorAsTurkishLira, parseTurkishLiraToMinor } from '@taktic/shared';
import type { ConfirmationProofKey } from '../../../lib/confirmation-proof-keys';
import { ConfirmGate, type ConfirmGateDecision } from '../../../components/confirm-gate';
import { cardKindLabel, readShowcaseTerms, showcasePackageTermsChanges, type ShowcasePackageTerms } from './package-changes';

/**
 * The vitrin catalogue's two save buttons that ask first
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A). Both read the form as it is
 * about to be posted; the server action reaches the same verdict on its own —
 * from the stored package for an edit — and refuses a save whose proofs do
 * not cover it. No new permission: SHOWCASE_PACKAGES_WRITE stays the gate.
 */

function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * "Paketi oluştur": a new vitrin package is on sale the moment it exists, so
 * it always asks (`showcase-package.create-active`) with its price, run
 * length and slug — and says the slug can never be changed.
 */
export function ShowcasePackageCreateSubmit() {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const data = new FormData(form);
    // A price the action will refuse with its own sentence is not worth a
    // question first; nothing is written either way.
    if (parseTurkishLiraToMinor(text(data, 'priceAmount')) === null) return null;
    const terms = readShowcaseTerms(data, 'TRY');
    return {
      proofs: ['showcase-package.create-active'],
      title: 'Vitrin paketi oluşturulup satışa açılsın mı?',
      tone: 'primary',
      confirmLabel: 'Evet, oluştur ve satışa aç',
      consequence: (
        <>
          <dl className="confirm-dialog-facts" data-testid="showcase-package-create-summary">
            <div>
              <dt>Paket</dt>
              <dd>{text(data, 'name') || '—'}</dd>
            </div>
            <div>
              <dt>Yayın bedeli</dt>
              <dd>{formatMinorAsTurkishLira(terms.priceAmount, terms.currency)}</dd>
            </div>
            <div>
              <dt>Yayın süresi</dt>
              <dd>{Number.isFinite(terms.durationDays) ? `${terms.durationDays} gün` : '—'}</dd>
            </div>
            <div>
              <dt>Kısa ad</dt>
              <dd>
                <code>{text(data, 'slug') || '—'}</code>
              </dd>
            </div>
            <div>
              <dt>Kart tipi</dt>
              <dd>{cardKindLabel(terms.allowedCardKind)}</dd>
            </div>
          </dl>
          <p>
            Paket oluşturulduğu anda <strong>satışa açılır</strong>: işletmeler bu bedelle hemen satın alabilir.
          </p>
          <p>
            Kısa ad <strong>kalıcıdır</strong>: ödeme sağlayıcısındaki ürün eşlemesinin anahtarıdır ve sonradan
            değiştirilemez. Yanlışsa paketi satıştan kaldırıp yenisini oluşturmak gerekir.
          </p>
        </>
      ),
    };
  }
  return <ConfirmGate triggerLabel="Paketi oluştur" triggerClassName="btn btn-primary" evaluate={evaluate} testId="showcase-package-create-submit" />;
}

/**
 * "Kaydet" on the package's own screen: asks when the save changes what a
 * purchase buys (`showcase-package.update-commercial`, old → new for each
 * line) or moves "Durum" (`showcase-package.activate` /
 * `showcase-package.deactivate`) — one dialog, one proof per change. A save of
 * the name, description or order goes straight through.
 */
export function ShowcasePackageEditSubmit({
  stored,
}: {
  stored: ShowcasePackageTerms & { name: string; isActive: boolean };
}) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const data = new FormData(form);
    if (parseTurkishLiraToMinor(text(data, 'priceAmount')) === null) return null;
    const changes = showcasePackageTermsChanges(stored, readShowcaseTerms(data, stored.currency));
    const nextActive = data.get('isActive') === 'on';
    const statusChange = nextActive !== stored.isActive;
    if (changes.length === 0 && !statusChange) return null;

    const proofs: ConfirmationProofKey[] = [];
    if (changes.length > 0) proofs.push('showcase-package.update-commercial');
    if (statusChange) proofs.push(nextActive ? 'showcase-package.activate' : 'showcase-package.deactivate');

    return {
      proofs,
      title: changes.length > 0 ? `“${stored.name}” satış koşulları değişsin mi?` : `“${stored.name}” durumu değişsin mi?`,
      tone: 'primary',
      confirmLabel: 'Evet, kaydet',
      consequence: (
        <>
          {changes.length > 0 ? (
            <>
              <dl className="confirm-dialog-facts" data-testid="showcase-package-commercial-changes">
                {changes.map((change) => (
                  <div key={change.key}>
                    <dt>{change.label}</dt>
                    <dd>
                      {change.from} → <strong>{change.to}</strong>
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Yeni koşullar <strong>bundan sonraki satın almalara</strong> uygulanır. Satılmış haklar ve yayındaki kartlar
                kendi kopyalarını taşır, değişmez.
              </p>
            </>
          ) : null}
          {statusChange ? (
            <p data-testid="showcase-package-status-change">
              {nextActive ? (
                <>
                  Durum <strong>Kapalı → Satışta</strong>: paket kaydedildiği anda yeniden satın alınabilir hâle gelir.
                </>
              ) : (
                <>
                  Durum <strong>Satışta → Kapalı</strong>: yeni satın almalar durur; mevcut haklar ve yayınlar değişmez.
                </>
              )}
            </p>
          ) : null}
        </>
      ),
    };
  }
  return <ConfirmGate triggerLabel="Kaydet" triggerClassName="btn btn-primary" evaluate={evaluate} testId="showcase-package-save" />;
}
