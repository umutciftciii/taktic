import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDate,
  getCurrentUser,
  SHOWCASE_CARD_KIND_LABELS,
  type ProviderProfile,
  type ShowcaseCard,
  type ShowcaseCardPublication,
  type ShowcasePublicationList,
  type ShowcasePublicationState,
} from '../../../../../lib/api';
import { ShowcaseCardFace, faceFromVersion } from '../../../../showcase-card-face';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import {
  submitShowcaseCardAction,
  unarchiveShowcaseCardAction,
  withdrawShowcaseSubmissionAction,
} from '../actions';
import { CardMenu } from '../card-menu';
import { SHOWCASE_ERROR_MESSAGES } from '../showcase-errors';
import { showcaseStage } from '../showcase-stage';
import { lastRejection, shownVersion } from '../showcase-ui';
import { StageAction } from '../stage-action';

type ShowcaseCardPageProps = {
  params: Promise<{ id: string; cardId: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    submitted?: string;
    withdrawn?: string;
    archived?: string;
    unarchived?: string;
    published?: string;
  }>;
};

/** The states under which a card counts as "on the air". */
const PUBLISHED_STATES = new Set<ShowcasePublicationState>(['LIVE', 'ACTIVATING', 'PAUSED']);

/**
 * One vitrin card: the face a customer sees, and beside it where the card
 * stands and the one thing to do about it.
 *
 * There is no form on this screen. Editing has its own screen, because a
 * summary with a long open form under it reads as a record to be maintained
 * rather than a shop window to be looked at — and a provider whose card is
 * live has, most days, nothing to change.
 *
 * Where the card stands comes from the publication endpoint, resolved by the
 * API into one state; this screen names the state and offers the next step,
 * and never works either out from the card's own fields. When that endpoint
 * cannot answer, the card reads as a plain draft rather than as a broken row.
 */
export default async function ShowcaseCardPage({ params, searchParams }: ShowcaseCardPageProps) {
  const { id, cardId } = await params;
  const query = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/${cardId}`);
  }

  const [provider, card, creditBalance, publication] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() => apiFetch<ShowcaseCard>(`/providers/${id}/showcase/cards/${cardId}`)),
    readCreditBalance(id),
    apiFetch<ShowcasePublicationList>(`/providers/${id}/showcase/publication`).catch(() => null),
  ]);

  if (provider.visibility === 'public') {
    redirect(`/providers/${id}/vitrin`);
  }

  const entry = publication?.cards.find((e) => e.cardId === cardId);
  const hasAvailableRight = (publication?.availableEntitlements.length ?? 0) > 0;
  const stage = showcaseStage(entry, { providerId: id, cardId, hasAvailableRight });
  const shown = shownVersion(card);
  const rejection = lastRejection(card);
  const onAir = entry ? PUBLISHED_STATES.has(entry.state) : false;
  // The API's own rule for retiring a card: one that has ever been approved
  // is archived and keeps its paid days; one that never was is deleted and
  // gives its right back. Read off the card, not the publication entry — a
  // failed fetch or a lapsed run must not relabel the dangerous action.
  const everLive = card.liveVersion !== null;
  const retired = card.status === 'SUSPENDED' || card.status === 'ARCHIVED';
  // A revision of a live card lives on the draft pointer while the publication
  // state stays LIVE, so the pair of pointers — not the state — says whether
  // there is a draft to send or a submission to take back.
  const pendingRevision = card.draftVersion?.reviewStatus === 'PENDING';
  const unsentRevision = everLive && card.draftVersion?.reviewStatus === 'DRAFT';
  const cardHref = `/providers/${id}/vitrin/${cardId}`;
  const editHref = `${cardHref}/duzenle`;
  // No second door to the editor when the primary action already opens it.
  const canEdit =
    !retired &&
    !pendingRevision &&
    !(stage.action?.kind === 'link' && stage.action.href === editHref);

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase"
      creditBalance={creditBalance}
      status={provider.status}
      hasShowcaseHistory={publication?.hasPublicationHistory ?? false}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/vitrin`}>Vitrin kartlarım</Link>
        <span aria-hidden="true">/</span>
        <span>{shown?.title ?? 'Vitrin kartı'}</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">
          {SHOWCASE_CARD_KIND_LABELS[card.kind]} · {card.category.name}
        </span>
        <h1 className="pdash-page-title">{shown?.title ?? 'Vitrin kartı'}</h1>
      </header>

      {query.error ? (
        <div className="pdash-notice pdash-notice-error" role="alert">
          {SHOWCASE_ERROR_MESSAGES[query.error] ?? SHOWCASE_ERROR_MESSAGES.SHOWCASE_SAVE_FAILED}
        </div>
      ) : null}
      {query.saved ? (
        <div className="pdash-notice" role="status">
          {everLive
            ? 'Değişiklikleriniz kaydedildi. İncelemeye gönderene kadar yayındaki metin aynı kalır.'
            : 'Değişiklikleriniz kaydedildi.'}
        </div>
      ) : null}
      {query.submitted ? (
        <div className="pdash-notice" role="status">
          Kartınız incelemeye gönderildi. Onaylanınca otomatik yayına girer.
        </div>
      ) : null}
      {query.withdrawn ? (
        <div className="pdash-notice" role="status">
          İnceleme geri çekildi. Kartınızı düzenleyip yeniden gönderebilirsiniz.
        </div>
      ) : null}
      {query.archived ? (
        <div className="pdash-notice" role="status">
          Kart arşivlendi ve yayından kalktı.
        </div>
      ) : null}
      {query.unarchived ? (
        <div className="pdash-notice" role="status">
          Kart arşivden çıkarıldı.
        </div>
      ) : null}
      {query.published ? (
        <div className="pdash-notice" role="status" data-testid="showcase-published-notice">
          {/*
            The bind endpoint answers 201 whether the card went live or only
            took the right; which one happened is read off the fresh state.
          */}
          {onAir ? 'Kartınız vitrinde yayına girdi.' : 'Vitrin hakkınız bu karta bağlandı.'}
        </div>
      ) : null}

      <div className="vitrin-summary">
        <section aria-labelledby="vitrin-ozet">
          <h2 id="vitrin-ozet" className="vitrin-section-title" style={{ marginTop: 0 }}>
            Kart özeti
          </h2>
          {shown ? (
            <ShowcaseCardFace
              card={faceFromVersion(card, shown)}
              badge={<span className={`vitrin-badge vitrin-badge-${stage.badge}`}>{stage.label}</span>}
              testId="showcase-card-face"
            />
          ) : (
            <p className="muted">Bu kartın henüz içeriği yok.</p>
          )}
          {shown ? (
            <div className="vitrin-summary-facts" style={{ marginTop: 16 }}>
              <div>
                <h2>Dahil olanlar</h2>
                <ul className="showcase-list">
                  {shown.scopeIncluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Hariç olanlar</h2>
                <ul className="showcase-list">
                  {shown.scopeExcluded.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Yanıt taahhüdü</h2>
                <p>
                  Acil: en geç {shown.responseSlaUrgentHours} saat · Normal: en geç{' '}
                  {shown.responseSlaNormalHours} saat
                </p>
              </div>
            </div>
          ) : null}
          {unsentRevision ? (
            <p className="muted" style={{ marginTop: 12 }}>
              Yayındaki metin gösteriliyor; kaydettiğiniz değişiklik incelemeye gönderilince burada görünecek.
            </p>
          ) : null}
          {pendingRevision && everLive ? (
            <p className="muted" style={{ marginTop: 12 }}>
              Yaptığınız değişiklik incelemede. Yayındaki metin şimdilik aynı kalıyor.
            </p>
          ) : null}
        </section>

        <aside className="vitrin-status" data-testid="showcase-status-panel" aria-labelledby="vitrin-durum">
          <div className="vitrin-status-head">
            <h2 id="vitrin-durum">{statusHeading(entry?.state, entry)}</h2>
            {!retired ? <CardMenu providerId={id} cardId={cardId} published={everLive} /> : null}
          </div>
          {entry?.state === 'LIVE' && entry.endAt ? (
            <p data-testid="showcase-live-until">
              Yayın bitişi: {formatDate(entry.endAt)}
              {entry.packageName ? ` · ${entry.packageName}` : ''}
            </p>
          ) : null}
          {entry?.state === 'LIVE' ? <p>Bu yayından gelen talep: {entry.leadCount}</p> : null}
          {stage.detail && entry?.state !== 'LIVE' ? <p>{stage.detail}</p> : null}
          {rejection && entry?.state === 'REJECTED' ? (
            <p className="vitrin-status-note" data-testid="showcase-review-note">
              <strong>İnceleme notu:</strong> {rejection.note}
            </p>
          ) : null}
          <StageAction stage={stage} providerId={id} cardId={cardId} />
          {unsentRevision ? (
            <>
              <p>Kaydettiğiniz değişiklik henüz incelemeye gönderilmedi.</p>
              <form action={submitShowcaseCardAction}>
                <input type="hidden" name="providerId" value={id} />
                <input type="hidden" name="cardId" value={cardId} />
                <button
                  className="pdash-btn pdash-btn-secondary"
                  type="submit"
                  data-testid="showcase-submit-revision"
                >
                  İncelemeye gönder
                </button>
              </form>
            </>
          ) : null}
          {pendingRevision ? (
            <form action={withdrawShowcaseSubmissionAction}>
              <input type="hidden" name="providerId" value={id} />
              <input type="hidden" name="cardId" value={cardId} />
              <button className="pdash-btn pdash-btn-ghost pdash-btn-sm" type="submit">
                İncelemeyi geri çek
              </button>
            </form>
          ) : null}
          {card.status === 'ARCHIVED' ? (
            <form action={unarchiveShowcaseCardAction}>
              <input type="hidden" name="providerId" value={id} />
              <input type="hidden" name="cardId" value={cardId} />
              <button className="pdash-btn pdash-btn-secondary" type="submit">
                Arşivden çıkar
              </button>
            </form>
          ) : null}
          {canEdit ? (
            <Link className="pdash-btn pdash-btn-ghost" href={editHref} data-testid="showcase-edit-link">
              Kartı düzenle
            </Link>
          ) : null}
        </aside>
      </div>
    </ProviderShell>
  );
}

/**
 * The status panel's title: what is true of the card right now, said to the
 * person who owns it. A REJECTED card whose right has lapsed reads as refused
 * outright, because editing alone will not get it back on the air.
 */
function statusHeading(
  state: ShowcasePublicationState | undefined,
  entry: ShowcaseCardPublication | undefined,
): string {
  switch (state ?? 'DRAFT') {
    case 'DRAFT':
      return 'Kartınızı incelemeye gönderin';
    case 'IN_REVIEW':
      return 'Kartınız inceleniyor';
    case 'REJECTED':
      return entry?.needsPackage ? 'Kartınız reddedildi' : 'Kartınızda düzenleme gerekiyor';
    case 'NEEDS_PACKAGE':
      return 'Kartınız pakete hazır';
    case 'EXPIRED':
      return entry?.hasRunBefore ? 'Yayın süreniz doldu' : 'Kartınız pakete hazır';
    case 'LIVE':
    case 'ACTIVATING':
      return 'Kartınız yayında';
    case 'PAUSED':
      return 'Kartınız geçici olarak görünmüyor';
    case 'ARCHIVED':
      return 'Kart arşivde';
    case 'SUSPENDED':
      return 'Kartınız durduruldu';
  }
}
