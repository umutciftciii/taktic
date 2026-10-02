'use client';

import { formatMinorAsTurkishLira, parseTurkishLiraToMinor } from '@taktic/shared';
import type { OfferPackageType } from '../../lib/api';
import type { ConfirmationProofKey } from '../../lib/confirmation-proof-keys';
import { ConfirmGate, type ConfirmGateDecision } from '../../components/confirm-gate';
import { packageTypeLabel } from './credit-package-cells';
import { creditPackageOfferText, creditPackageTermsChanges, type CreditPackageTerms } from './package-changes';

/**
 * The two credit-package save buttons that ask first only when the save needs
 * it (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A). Both read the form as it
 * is about to be posted; the server action reaches the same verdict from the
 * stored package and refuses a save whose proofs do not cover it.
 */

function readNumber(data: FormData, name: string): number | null {
  const raw = data.get(name);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readTerms(data: FormData, type: OfferPackageType): CreditPackageTerms {
  return {
    type,
    priceAmount: parseTurkishLiraToMinor(String(data.get('priceAmount') ?? '')) ?? 0,
    currency: String(data.get('currency') ?? 'TRY').toUpperCase(),
    creditAmount: readNumber(data, 'creditAmount'),
    quotaCredits: readNumber(data, 'quotaCredits'),
    dailyOfferLimit: readNumber(data, 'dailyOfferLimit'),
    scopeCategoryIds: data.getAll('scopeCategoryIds').filter((value): value is string => typeof value === 'string' && value !== ''),
  };
}

/**
 * "Paketi oluştur": an active package goes on sale the moment it exists, so
 * creating one asks (`credit-package.create-active`) with its name, type,
 * price and what it sells. An inactive package is created in one click.
 */
export function CreditPackageCreateSubmit() {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const data = new FormData(form);
    if (data.get('isActive') !== 'true') return null;
    // A price the action will refuse with its own sentence is not worth a
    // question first; nothing is written either way.
    if (parseTurkishLiraToMinor(String(data.get('priceAmount') ?? '')) === null) return null;
    const type = (String(data.get('type') ?? 'ONE_TIME_CREDITS') as OfferPackageType) || 'ONE_TIME_CREDITS';
    const terms = readTerms(data, type);
    const name = String(data.get('name') ?? '').trim();
    return {
      proofs: ['credit-package.create-active'],
      title: 'Paket aktif olarak oluşturulsun mu?',
      tone: 'primary',
      confirmLabel: 'Evet, aktif olarak oluştur',
      consequence: (
        <>
          <dl className="confirm-dialog-facts" data-testid="credit-package-create-summary">
            <div>
              <dt>Paket</dt>
              <dd>{name || '—'}</dd>
            </div>
            <div>
              <dt>Tür</dt>
              <dd>{packageTypeLabel(type)}</dd>
            </div>
            <div>
              <dt>Fiyat</dt>
              <dd>{formatMinorAsTurkishLira(terms.priceAmount, terms.currency)}</dd>
            </div>
            <div>
              <dt>Satılan</dt>
              <dd>{creditPackageOfferText(terms)}</dd>
            </div>
          </dl>
          <p>
            Paket <strong>aktif</strong> oluşturulur ve hizmet verenlerin satın alma ekranında <strong>hemen satışa
            çıkar</strong>. Önce pasif oluşturup sonra aktifleştirmek isterseniz durumu “Pasif” seçin.
          </p>
        </>
      ),
    };
  }
  return <ConfirmGate triggerLabel="Paketi oluştur" triggerClassName="btn btn-primary btn-sm" evaluate={evaluate} testId="credit-package-create-submit" />;
}

/**
 * "Değişiklikleri kaydet": asks when the save changes what a purchase buys or
 * costs (`credit-package.update-commercial`, old → new for each line), or
 * moves the status from the form's own select (`credit-package.activate` /
 * `credit-package.deactivate`) — one dialog, one proof per change, so a
 * status change saved together with other edits is asked like the header
 * button. A save that touches only the name, slug, description or order goes
 * straight through.
 */
export function CreditPackageEditSubmit({
  stored,
  statusEditable,
  categoryNames,
}: {
  stored: CreditPackageTerms & { name: string; isActive: boolean };
  statusEditable: boolean;
  categoryNames: Record<string, string>;
}) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const data = new FormData(form);
    if (parseTurkishLiraToMinor(String(data.get('priceAmount') ?? '')) === null) return null;
    const next = readTerms(data, stored.type);
    const changes = creditPackageTermsChanges(stored, next, categoryNames);
    const nextActive = statusEditable ? data.get('isActive') === 'true' : stored.isActive;
    const statusChange = nextActive !== stored.isActive;
    if (changes.length === 0 && !statusChange) return null;

    const proofs: ConfirmationProofKey[] = [];
    if (changes.length > 0) proofs.push('credit-package.update-commercial');
    if (statusChange) proofs.push(nextActive ? 'credit-package.activate' : 'credit-package.deactivate');

    return {
      proofs,
      title: changes.length > 0 ? `“${stored.name}” ticari koşulları değişsin mi?` : `“${stored.name}” durumu değişsin mi?`,
      tone: 'primary',
      confirmLabel: 'Evet, kaydet',
      consequence: (
        <>
          {changes.length > 0 ? (
            <>
              <dl className="confirm-dialog-facts" data-testid="credit-package-commercial-changes">
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
                Yeni koşullar <strong>bundan sonraki satın almalara</strong> uygulanır. Mevcut satın almalar, yüklenmiş
                krediler ve devam eden dönemler değişmez; her satın alma kendi anındaki fiyatı ve kredisini saklar.
              </p>
            </>
          ) : null}
          {statusChange ? (
            <p data-testid="credit-package-status-change">
              {nextActive ? (
                <>
                  Durum <strong>Pasif → Aktif</strong>: paket kaydedildiği anda bu fiyatla <strong>satışa açılır</strong>.
                </>
              ) : (
                <>
                  Durum <strong>Aktif → Pasif</strong>: paket <strong>yeni satışa kapanır</strong>; mevcut satın almalar
                  ve krediler değişmez.
                </>
              )}
            </p>
          ) : null}
        </>
      ),
    };
  }
  return <ConfirmGate triggerLabel="Değişiklikleri kaydet" triggerClassName="btn btn-primary" evaluate={evaluate} testId="credit-package-save" />;
}
