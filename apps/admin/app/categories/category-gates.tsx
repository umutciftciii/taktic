'use client';

import type { ReactNode } from 'react';
import type { CategoryStatus } from '../../lib/api';
import { ConfirmGate, type ConfirmGateDecision } from '../../components/confirm-gate';
import {
  categoryChanges,
  categoryPayload,
  categoryProofKeys,
  categoryStatusProofKey,
  readRouterRules,
  routerRuleChanges,
  type CategoryChanges,
  type CategoryPlacementImpact,
  type CategoryStored,
} from './category-changes';
import { KIND_LABELS, STATUS_LABELS } from './category-taxonomy';

/**
 * The category screens' save buttons that ask first
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). Each reads the form as it is
 * about to be posted; the server action reaches the same verdict on its own —
 * from the stored category for an edit — and refuses a save whose proofs do
 * not cover it. No new permission: CATEGORIES_WRITE / CATEGORIES_STATUS stay
 * the gates.
 */

function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * "Kategoriyi oluştur": a DRAFT goes straight through; any other status
 * (`category.create-published`) asks with the name, the type and the status.
 */
export function CategoryCreateSubmit() {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const data = new FormData(form);
    const payload = categoryPayload(data);
    if (payload.status === 'DRAFT') return null;
    const status = payload.status ?? 'ACTIVE';
    return {
      proofs: ['category.create-published'],
      title:
        status === 'ACTIVE' ? 'Kategori yayında olarak oluşturulsun mu?' : 'Kategori kapalı olarak oluşturulsun mu?',
      tone: 'primary',
      confirmLabel: status === 'ACTIVE' ? 'Evet, oluştur ve yayına al' : 'Evet, kapalı olarak oluştur',
      consequence: (
        <>
          <dl className="confirm-dialog-facts" data-testid="category-create-summary">
            <div>
              <dt>Kategori</dt>
              <dd>{text(data, 'name') || '—'}</dd>
            </div>
            <div>
              <dt>Tip</dt>
              <dd>{KIND_LABELS[payload.kind] ?? payload.kind}</dd>
            </div>
            <div>
              <dt>Durum</dt>
              <dd>{STATUS_LABELS[status] ?? status}</dd>
            </div>
          </dl>
          {status === 'ACTIVE' ? (
            <p>
              Kategori oluşturulduğu anda <strong>müşteri kataloğunda yayınlanır</strong>: müşteriler bu kategoride talep
              açabilir ve talepler hizmet verenlerle eşleşir. Hazır değilse “Taslak” seçip yayın kontrol listesini
              tamamladıktan sonra yayına alın.
            </p>
          ) : (
            <p>
              Kategori <strong>kapalı</strong> oluşturulur: katalogda görünmez, yeni talep ve hizmet veren seçimi kapalıdır.
              Hazırlık için “Taslak” durumu daha uygundur.
            </p>
          )}
        </>
      ),
    };
  }
  return (
    <ConfirmGate
      triggerLabel="Kategoriyi oluştur"
      triggerClassName="btn btn-primary btn-sm"
      evaluate={evaluate}
      testId="category-create-submit"
    />
  );
}

/**
 * "Kategoriyi kaydet" on the category's own screen: asks when the save moves
 * the slug, the type or the parent (`category.structure-update`), the offer
 * price (`category.offer-credit-update`), switches unlimited-package
 * eligibility on (`category.unlimited-enable`) or moves "Durum"
 * (`category.activate` / `category.deactivate`) — one dialog, one proof per
 * change. A save of the name, description, pictures or order goes straight
 * through.
 */
export function CategoryEditSubmit({
  stored,
  parentNames,
  impact,
}: {
  stored: CategoryStored;
  /** Group id → name, for the parent line. */
  parentNames: Record<string, string>;
  impact: CategoryPlacementImpact;
}) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const changes = categoryChanges(stored, categoryPayload(new FormData(form)));
    const proofs = categoryProofKeys(changes);
    if (proofs.length === 0) return null;
    const structural = Boolean(changes.slug || changes.kind || changes.parent);
    const deactivating = changes.status !== null && changes.status.to !== 'ACTIVE';
    return {
      proofs,
      title: 'Kategori değişiklikleri kaydedilsin mi?',
      tone: structural || deactivating ? 'danger' : 'primary',
      confirmLabel: 'Evet, kaydet',
      consequence: (
        <CategoryChangeConsequence changes={changes} parentNames={parentNames} impact={impact} />
      ),
    };
  }
  return (
    <ConfirmGate
      triggerLabel="Kategoriyi kaydet"
      triggerClassName="btn btn-primary"
      evaluate={evaluate}
      testId="category-save"
    />
  );
}

/**
 * "Durumu güncelle" on the status card: asks for any move
 * (`category.activate` / `category.deactivate`); pressing it on the current
 * status writes the same value back and asks nothing.
 */
export function CategoryStatusSubmit({
  stored,
  impact,
}: {
  stored: Pick<CategoryStored, 'name' | 'status'>;
  impact: CategoryPlacementImpact;
}) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const to = text(new FormData(form), 'status') as CategoryStatus;
    if (!to || to === stored.status) return null;
    return {
      proofs: [categoryStatusProofKey(to)],
      title: `Kategori durumu “${STATUS_LABELS[to] ?? to}” olsun mu?`,
      tone: to === 'ACTIVE' ? 'primary' : 'danger',
      confirmLabel: to === 'ACTIVE' ? 'Evet, yayına al' : `Evet, ${(STATUS_LABELS[to] ?? to).toLocaleLowerCase('tr-TR')} yap`,
      consequence: <StatusChangeConsequence from={stored.status} to={to} impact={impact} />,
    };
  }
  return (
    <ConfirmGate
      triggerLabel="Durumu güncelle"
      triggerClassName="btn btn-secondary"
      evaluate={evaluate}
      testId="category-status-submit"
    />
  );
}

/**
 * "Yönlendirmeyi kaydet": asks when the save sends any option somewhere else
 * (`category.router-rules-update`), with each moved option old → new; saving
 * the same map goes straight through (Paket B, inventory V#29).
 */
export function RouterRulesSubmit({
  stored,
  optionLabels,
  targetNames,
}: {
  stored: ReadonlyArray<{ optionKey: string; targetCategorySlug: string }>;
  /** Option key → its label on the routing question. */
  optionLabels: Record<string, string>;
  /** Category slug → its name, for the target lines. */
  targetNames: Record<string, string>;
}) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const changes = routerRuleChanges(stored, readRouterRules(new FormData(form)));
    if (changes.length === 0) return null;
    const target = (slug: string | null) => (slug === null ? 'hedef yok' : (targetNames[slug] ?? slug));
    const removed = changes.filter((change) => change.to === null).length;
    return {
      proofs: ['category.router-rules-update'],
      title: 'Yönlendirme değişsin mi?',
      tone: removed > 0 ? 'danger' : 'primary',
      confirmLabel: 'Evet, yönlendirmeyi kaydet',
      consequence: (
        <>
          <dl className="confirm-dialog-facts" data-testid="router-rules-changes">
            {changes.map((change) => (
              <div key={change.optionKey}>
                <dt>{optionLabels[change.optionKey] ?? change.optionKey}</dt>
                <dd>
                  {target(change.from)} → <strong>{target(change.to)}</strong>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            Kaydettiğiniz anda bu seçenekleri işaretleyen müşteriler <strong>yeni hedefe</strong> taşınır.
            {removed > 0
              ? ` Hedefi kaldırılan ${removed} seçenek müşteriyi hiçbir hizmete taşımaz; o seçenekle talep tamamlanamaz.`
              : ''}{' '}
            Açılmış talepler değişmez.
          </p>
        </>
      ),
    };
  }
  return (
    <ConfirmGate
      triggerLabel="Yönlendirmeyi kaydet"
      triggerClassName="btn btn-primary"
      evaluate={evaluate}
      testId="router-rules-save"
    />
  );
}

export function CategoryChangeConsequence({
  changes,
  parentNames,
  impact,
}: {
  changes: CategoryChanges;
  parentNames: Record<string, string>;
  impact: CategoryPlacementImpact;
}) {
  const parentLabel = (id: string | null) => (id === null ? 'üst seviye' : (parentNames[id] ?? 'bilinmeyen grup'));
  const sections: ReactNode[] = [];

  if (changes.slug || changes.kind || changes.parent) {
    sections.push(
      <div key="structure" data-testid="category-structure-change">
        <dl className="confirm-dialog-facts">
          {changes.slug ? (
            <div>
              <dt>Kısa ad</dt>
              <dd>
                <code>{changes.slug.from}</code> → <strong><code>{changes.slug.to}</code></strong>
              </dd>
            </div>
          ) : null}
          {changes.kind ? (
            <div>
              <dt>Tip</dt>
              <dd>
                {KIND_LABELS[changes.kind.from]} → <strong>{KIND_LABELS[changes.kind.to]}</strong>
              </dd>
            </div>
          ) : null}
          {changes.parent ? (
            <div>
              <dt>Üst kategori</dt>
              <dd>
                {parentLabel(changes.parent.from)} → <strong>{parentLabel(changes.parent.to)}</strong>
              </dd>
            </div>
          ) : null}
        </dl>
        {changes.slug ? (
          <p>
            Kısa ad kategorinin adresidir: <strong>eski adrese verilmiş dış bağlantılar ve arama motoru kayıtları
            kırılabilir</strong> (eski adres yeni adrese yönlenmez).
          </p>
        ) : null}
        {changes.kind || changes.parent ? (
          <p>
            <strong>Kategori ağacı değişir:</strong> kategorinin katalogdaki yeri
            {changes.kind ? ' ve talep alıp almadığı (tipine göre)' : ''} bu kayıtla birlikte değişir.
          </p>
        ) : null}
      </div>,
    );
  }

  if (changes.offerCreditCost) {
    sections.push(
      <div key="credit" data-testid="category-offer-credit-change">
        <dl className="confirm-dialog-facts">
          <div>
            <dt>Teklif kredisi</dt>
            <dd>
              {changes.offerCreditCost.from === null ? 'tanımsız' : `${changes.offerCreditCost.from} kredi`} →{' '}
              <strong>{changes.offerCreditCost.to} kredi</strong>
            </dd>
          </div>
        </dl>
        <p>
          Yeni fiyat <strong>yalnız bundan sonra verilecek tekliflere</strong> uygulanır; verilmiş teklifler ve iadeleri
          değişmez.
        </p>
      </div>,
    );
  }

  if (changes.unlimitedEnable) {
    sections.push(
      <p key="unlimited" data-testid="category-unlimited-enable">
        <strong>Limitsiz paket uygunluğu açılıyor:</strong> bu kategori (ve grupsa alt kategorileri) kategori limitsiz
        paketlerin kapsamına girebilir; böyle bir paket alan hizmet verenler bu kategoride paketin kurallarıyla teklif
        verir. Regüle veya yüksek değerli kategorilerde kapalı bırakın. Kapatmak onay istemez.
      </p>,
    );
  }

  if (changes.status) {
    sections.push(<StatusChangeConsequence key="status" from={changes.status.from} to={changes.status.to} impact={impact} />);
  }

  return <>{sections}</>;
}

/**
 * What a status move does, as `CategoriesService.applyStatusChange` does it:
 * leaving ACTIVE suspends this category's ACTIVE vitrin runs with
 * CATEGORY_CLOSED and the clock stopped; entering ACTIVE resumes the runs that
 * reason held. Moving between DRAFT and INACTIVE touches no run.
 */
export function StatusChangeConsequence({
  from,
  to,
  impact,
}: {
  from: CategoryStatus;
  to: CategoryStatus;
  impact: CategoryPlacementImpact;
}) {
  const move = (
    <p>
      Durum <strong>{STATUS_LABELS[from]} → {STATUS_LABELS[to]}</strong>.
    </p>
  );

  if (to === 'ACTIVE') {
    return (
      <div data-testid="category-status-activate">
        {move}
        <ul>
          <li>
            <strong>Müşteri kataloğunda yayına çıkar:</strong> müşteriler bu kategoride talep açabilir, talepler hizmet
            verenlerle eşleşir.
          </li>
          <li>
            Kategori kapandığı için durmuş (“Kategori kapalı”) vitrin yerleşimleri kendiliğinden yeniden yayına girer;
            durdukları süre bitiş tarihlerine eklenir.{' '}
            {impact === null
              ? 'Bu yerleşimlerin sayısı bu ekranda gösterilemiyor.'
              : `Şu anda bu sebeple duran ${impact.heldByClosure} yerleşim var.`}
          </li>
        </ul>
      </div>
    );
  }

  if (from !== 'ACTIVE') {
    return (
      <div data-testid="category-status-deactivate">
        {move}
        <p>Kategori zaten yayında değil; katalog ve vitrin yerleşimleri bu değişiklikten etkilenmez.</p>
      </div>
    );
  }

  return (
    <div data-testid="category-status-deactivate">
      {move}
      <ul>
        <li>
          <strong>Müşteri kataloğundan çıkar:</strong> bu kategoride yeni talep açılamaz ve yeni hizmet veren seçimi
          kapanır. Geçmiş talepler, teklifler ve cevaplar okunmaya devam eder.
        </li>
        <li data-testid="category-status-deactivate-placements">
          <strong>Yayındaki vitrin yerleşimleri askıya alınır</strong> (“Kategori kapalı”) ve süreleri durur.{' '}
          {impact === null
            ? 'Etkilenecek yerleşim sayısı bu ekranda gösterilemiyor (yerleşimleri görme yetkiniz yok ya da okunamadı).'
            : impact.onAir === 0
              ? 'Şu anda bu kategoride yayında yerleşim yok.'
              : `Şu anda bu kategoride yayında ${impact.onAir} yerleşim var; hepsi raftan iner.`}
        </li>
        <li>
          Kategori yeniden “Yayında” yapılırsa bu sebeple duran uygun yerleşimler kendiliğinden devam eder ve durdukları
          süre bitiş tarihlerine eklenir.
        </li>
      </ul>
    </div>
  );
}
