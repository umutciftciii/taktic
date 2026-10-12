import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoundTimelinePanel } from '../app/requests/[id]/round-timeline';
import { MatchReviewQueueCard } from '../app/requests/match-review-queue';
import { adminPermissionLabel } from '../lib/api';
import { buildAdminDashboardMetrics, MATCH_REVIEW_REQUESTS_HREF } from '../lib/dashboard-metrics';
import { buildDashboardQueues } from '../lib/dashboard-overview';
import {
  MATCH_ROUND_STATUS_LABELS,
  openNextRoundErrorMessage,
  openNextRoundTarget,
  SCHEDULE_MISSING_NOTE,
  type AdminRoundTimeline,
  type AdminRoundTimelineRound,
} from '../lib/match-rounds';

/**
 * REL-002 Faz 5 — the admin round timeline, "Yeni tur aç", the MATCH_REVIEW
 * queue and its dashboard cell.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const noop = () => undefined;

function round(overrides: Partial<AdminRoundTimelineRound>): AdminRoundTimelineRound {
  return {
    id: 'mr1_req',
    roundNumber: 1,
    status: 'FAILED',
    source: 'MARKETPLACE',
    openedBy: 'REQUEST_CREATED',
    openedAt: '2026-10-01T09:00:00.000Z',
    publishedAt: '2026-10-01T09:05:00.000Z',
    expiresAt: '2026-10-15T09:05:00.000Z',
    reminderSentAt: null,
    matchedAt: '2026-10-02T09:00:00.000Z',
    matchedOfferId: 'off1',
    matchedProviderId: 'prov1',
    completedAt: null,
    cancelledAt: null,
    expiredAt: null,
    failedAt: '2026-10-05T09:00:00.000Z',
    isCurrent: false,
    offerCount: 2,
    winnerScheduleMissing: false,
    matchedProvider: { id: 'prov1', businessName: 'Usta Klima' },
    matchedOffer: { id: 'off1', offerNumber: 'OFF-1', estimatedStartDate: '2026-10-03', estimatedCompletionDate: '2026-10-04' },
    failureIncident: {
      id: 'inc1',
      incidentNumber: 'INC-2026-000001',
      providerId: 'prov1',
      offerId: 'off1',
      reason: 'PROVIDER_NO_SHOW',
      customerNote: null,
      status: 'CONFIRMED',
      reportedAt: '2026-10-05T09:00:00.000Z',
      effectiveDecision: 'CONFIRMED',
      corrected: false,
    },
    thread: { id: 't1', mode: 'READ_ONLY' },
    contactRevealed: true,
    opening: null,
    ...overrides,
  };
}

function matchReviewTimeline(): AdminRoundTimeline {
  return {
    requestId: 'req',
    requestStatus: 'MATCH_REVIEW',
    currentRoundId: 'mr3_req',
    exclusions: [1, 2, 3].map((n) => ({
      providerId: `prov${n}`,
      sourceRoundId: `mr${n}_req`,
      incidentId: `inc${n}`,
      reason: 'PROVIDER_NO_SHOW',
      createdAt: '2026-10-05T09:00:00.000Z',
    })),
    rounds: [
      round({}),
      round({ id: 'mr2_req', roundNumber: 2, openedBy: 'SERVICE_ISSUE' }),
      round({ id: 'mr3_req', roundNumber: 3, openedBy: 'SERVICE_ISSUE', isCurrent: true }),
    ],
  };
}

const CAN_ALL = { openRound: true, openIncidents: true, openProviders: true, openReliability: true, openOffers: true };

describe('"Yeni tur aç" applies only to a request waiting on its failed Round 3+', () => {
  it('targets the failed current round in MATCH_REVIEW', () => {
    expect(openNextRoundTarget(matchReviewTimeline())?.id).toBe('mr3_req');
  });

  it('never on another status, a live round, or before the automatic limit', () => {
    expect(openNextRoundTarget({ ...matchReviewTimeline(), requestStatus: 'CANCELLED' })).toBeNull();
    const live = matchReviewTimeline();
    live.rounds.push(round({ id: 'mr4_req', roundNumber: 4, status: 'OPEN', openedBy: 'ADMIN' }));
    expect(openNextRoundTarget(live)).toBeNull();
    const early = matchReviewTimeline();
    early.currentRoundId = 'mr2_req';
    expect(openNextRoundTarget(early)).toBeNull();
  });
});

describe('the round timeline', () => {
  it('draws one labelled article per round, oldest first, each status written out', () => {
    const markup = html(
      <RoundTimelinePanel timeline={matchReviewTimeline()} can={CAN_ALL} action={noop} idempotencyKey="k" roundError={undefined} roundOpened={false} />,
    );
    expect(markup.match(/<article class="round-card" aria-labelledby="round-\d-title"/g)).toHaveLength(3);
    expect(markup.indexOf('Tur 1')).toBeLessThan(markup.indexOf('Tur 2'));
    expect(markup).toContain(MATCH_ROUND_STATUS_LABELS.FAILED);
    expect(markup).toContain('Güncel tur');
    expect(markup).toContain('Kapandı · salt okunur');
    expect(markup).toContain('Geçerli karar: Doğrulandı');
    expect(markup).toContain('href="/service-incidents/inc1"');
    expect(markup).toContain('href="/providers/prov1#guvenilirlik"');
    expect(markup).toContain('Bu turun hizmet vereni talepten kalıcı olarak dışlandı.');
  });

  it('offers the form to a holder of the permission, with the hidden failed round and key, a mandatory note and a confirmation', () => {
    const markup = html(
      <RoundTimelinePanel timeline={matchReviewTimeline()} can={CAN_ALL} action={noop} idempotencyKey="key-123" roundError={undefined} roundOpened={false} />,
    );
    expect(markup).toContain('data-testid="open-next-round-form"');
    expect(markup).toContain('name="expectedCurrentRoundId" value="mr3_req"');
    expect(markup).toContain('name="idempotencyKey" value="key-123"');
    expect(markup).toMatch(/<textarea[^>]*name="note"[^>]*required=""[^>]*minLength="10"[^>]*maxLength="2000"/);
    expect(markup).toContain('for="open-next-round-note"');
    expect(markup).toContain('Yeni tur aç (Tur 4)');
    const source = read('app/requests/[id]/round-timeline.tsx');
    expect(source).toMatch(/<ConfirmDialog\s+proof="request.open-next-round"\s+triggerLabel="Yeni tur aç"/);
    expect(source).toContain('Kredi iadesi yapılmaz');
  });

  it('without the permission: no form, a note saying who may', () => {
    const markup = html(
      <RoundTimelinePanel
        timeline={matchReviewTimeline()}
        can={{ ...CAN_ALL, openRound: false }}
        action={noop}
        idempotencyKey="k"
        roundError={undefined}
        roundOpened={false}
      />,
    );
    expect(markup).not.toContain('open-next-round-form');
    expect(markup).toContain('Yeni tur açmak yalnız süper yöneticiye açıktır.');
  });

  it('marks an admin-opened round with its opener and internal note; no action on historical rounds', () => {
    const timeline = matchReviewTimeline();
    timeline.requestStatus = 'APPROVED';
    timeline.currentRoundId = 'mr4_req';
    timeline.rounds[2] = { ...timeline.rounds[2]!, isCurrent: false };
    timeline.rounds.push(
      round({
        id: 'mr4_req',
        roundNumber: 4,
        status: 'OPEN',
        openedBy: 'ADMIN',
        isCurrent: true,
        matchedOfferId: null,
        matchedProviderId: null,
        matchedProvider: null,
        matchedOffer: null,
        matchedAt: null,
        failedAt: null,
        failureIncident: null,
        thread: null,
        winnerScheduleMissing: null,
        opening: {
          id: 'o1',
          fromRoundId: 'mr3_req',
          note: 'Müşteriyle görüşüldü.',
          createdAt: '2026-10-06T09:00:00.000Z',
          openedBy: { id: 'sa1', name: 'Süper Yönetici' },
        },
      }),
    );
    const markup = html(<RoundTimelinePanel timeline={timeline} can={CAN_ALL} action={noop} idempotencyKey="k" roundError={undefined} roundOpened />);
    expect(markup).toContain('Yönetici açtı');
    expect(markup).toContain('Süper Yönetici');
    expect(markup).toContain('Müşteriyle görüşüldü.');
    expect(markup).not.toContain('open-next-round-form');
    expect(markup).toContain('role="status"');
  });

  it('flags a legacy match with no promised days, and maps every refusal code to a sentence', () => {
    const timeline: AdminRoundTimeline = {
      requestId: 'req',
      requestStatus: 'MATCHED',
      currentRoundId: 'mr1_req',
      exclusions: [],
      rounds: [
        round({
          status: 'MATCHED',
          isCurrent: true,
          failedAt: null,
          failureIncident: null,
          winnerScheduleMissing: true,
          matchedOffer: { id: 'off1', offerNumber: 'OFF-1', estimatedStartDate: null, estimatedCompletionDate: null },
          thread: { id: 't1', mode: 'ACTIVE' },
        }),
      ],
    };
    const markup = html(
      <RoundTimelinePanel timeline={timeline} can={CAN_ALL} action={noop} idempotencyKey="k" roundError="MATCH_REVIEW_ALREADY_REOPENED" roundOpened={false} />,
    );
    expect(markup).toContain(SCHEDULE_MISSING_NOTE);
    expect(markup).toContain('Açık yazışma');
    expect(markup).toContain('role="alert"');
    for (const code of [
      'confirmation',
      'MATCH_REVIEW_NOTE_REQUIRED',
      'MATCH_REVIEW_ALREADY_REOPENED',
      'REQUEST_NOT_IN_MATCH_REVIEW',
      'ROUND_CHANGED',
      'IDEMPOTENCY_KEY_REUSED',
      'SUPER_ADMIN_REQUIRED',
    ]) {
      expect(openNextRoundErrorMessage(code)).not.toBe(openNextRoundErrorMessage('unknown'));
    }
  });

  it('a session without OFFERS_READ sees no winner name (the API leaves the key out)', () => {
    const timeline = matchReviewTimeline();
    for (const entry of timeline.rounds) {
      delete entry.matchedProvider;
      delete entry.matchedOffer;
      delete entry.contactRevealed;
    }
    const markup = html(
      <RoundTimelinePanel timeline={timeline} can={{ ...CAN_ALL, openOffers: false }} action={noop} idempotencyKey="k" roundError={undefined} roundOpened={false} />,
    );
    expect(markup).not.toContain('Usta Klima');
    expect(markup).toContain('Teklif okuma izniniz yok');
    expect(markup).not.toContain('İletişim paylaşımı');
  });
});

describe('the MATCH_REVIEW queue and its dashboard cell', () => {
  it('lists rows with links to the timeline, the incident and the reliability record', () => {
    const markup = html(
      <MatchReviewQueueCard
        canOpenIncidents
        canOpenReliability={false}
        queue={{
          total: 1,
          items: [
            {
              id: 'req',
              requestNumber: 'TLP-1',
              city: 'İstanbul',
              district: 'Kadıköy',
              submittedAt: '2026-10-01T09:00:00.000Z',
              category: { id: 'c', name: 'Klima' },
              currentRound: {
                id: 'mr3_req',
                roundNumber: 3,
                failedAt: '2026-10-05T09:00:00.000Z',
                failureIncident: {
                  id: 'inc3',
                  incidentNumber: 'INC-3',
                  status: 'REPORTED',
                  reason: 'PROVIDER_NO_SHOW',
                  providerId: 'prov3',
                  provider: { businessName: 'Usta' },
                },
              },
              exclusionCount: 3,
              manualOpeningCount: 0,
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('İnceleme bekleyen eşleşmeler');
    expect(markup).toContain('href="/requests/req?tab=turlar"');
    expect(markup).toContain('href="/service-incidents/inc3"');
    expect(markup).not.toContain('#guvenilirlik');
  });

  it('counts the queue on the dashboard only when the API sent the count', () => {
    const base = {
      totalRequests: 1,
      pendingRequests: 0,
      inReviewRequests: 0,
      approvedProviders: 0,
      pendingProviders: 0,
      totalOffers: 0,
      refundableOffers: 0,
      packagePurchases: 0,
      openSupportTickets: 0,
      openRequestReports: 0,
    };
    const withCount = buildAdminDashboardMetrics({ ...base, matchReviewRequests: 2 });
    const metric = withCount.find((entry) => entry.key === 'matchReviewRequests');
    expect(metric).toMatchObject({ value: 2, href: MATCH_REVIEW_REQUESTS_HREF, tone: 'warning' });
    expect(buildDashboardQueues(withCount, () => true).map((cell) => cell.metricKey)).toContain('matchReviewRequests');
    expect(buildAdminDashboardMetrics(base).some((entry) => entry.key === 'matchReviewRequests')).toBe(false);
  });

  it('labels the reserved permission in the Talepler area', () => {
    expect(adminPermissionLabel('MATCH_REVIEW_OPEN_ROUND')).toEqual({
      area: 'Talepler',
      action: 'eşleşme incelemesinden yeni tur açma (yalnız süper yönetici)',
    });
  });
});
