import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IncidentAdjudicateForm, IncidentCorrectForm } from '../app/service-incidents/[id]/incident-decision-forms';
import { ReviewActions } from '../app/provider-reliability/review-actions';
import { ProviderReliabilityCard } from '../app/providers/[id]/provider-reliability-card';
import { ReservedPermissionsNote } from '../app/roles/reserved-permissions-note';
import { adminPermissionLabel, grantablePermissions } from '../lib/api';
import { allNavItems } from '../lib/nav';
import {
  PROVIDER_INCIDENT_STATUS_LABELS,
  RELIABILITY_LEVEL_LABELS,
  RELIABILITY_REVIEW_STATUS_LABELS,
  SERVICE_ISSUE_REASON_LABELS,
  hoursLeft,
  reliabilityNotice,
  serviceIncidentErrorMessage,
  type ProviderReliabilityView,
} from '../lib/service-incidents';

/**
 * REL-002 Faz 4 — the admin incident and reliability screens: the locked copy,
 * the permission labels, the nav rows, the decision forms' hooks, and the
 * reliability card.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const noop = () => undefined;

describe('locked copy', () => {
  it('names statuses, levels and review states exactly', () => {
    expect(PROVIDER_INCIDENT_STATUS_LABELS).toEqual({
      REPORTED: 'Bildirildi',
      PROVIDER_RESPONDED: 'Hizmet veren yanıtladı',
      CONFIRMED: 'Doğrulandı',
      DISMISSED: 'Reddedildi',
    });
    expect(RELIABILITY_LEVEL_LABELS).toEqual({
      NORMAL: 'Normal',
      WARNING: 'Uyarı',
      ADMIN_REVIEW_REQUIRED: 'Yönetici incelemesi gerekli',
    });
    expect(RELIABILITY_REVIEW_STATUS_LABELS).toEqual({ OPEN: 'Açık', ACKNOWLEDGED: 'Üstlenildi', RESOLVED: 'Sonuçlandı' });
  });

  it('mirrors the API reason labels', () => {
    const source = readFileSync(
      resolve(__dirname, '../../api/src/modules/service-issues/service-issue-eligibility.ts'),
      'utf8',
    );
    for (const label of Object.values(SERVICE_ISSUE_REASON_LABELS)) {
      expect(source).toContain(`'${label}'`);
    }
  });

  it('never says "strike" on these screens', () => {
    for (const path of [
      'lib/service-incidents.ts',
      'app/service-incidents/page.tsx',
      'app/service-incidents/[id]/page.tsx',
      'app/service-incidents/[id]/incident-decision-forms.tsx',
      'app/provider-reliability/page.tsx',
      'app/provider-reliability/review-actions.tsx',
      'app/providers/[id]/provider-reliability-card.tsx',
    ]) {
      expect(read(path).toLowerCase()).not.toContain('strike');
    }
  });

  it('maps the API refusal codes to Turkish, the stale-head 409 included', () => {
    expect(serviceIncidentErrorMessage('INCIDENT_ADJUDICATION_CHANGED')).toBe(
      'Karar bu sayfa açıldıktan sonra değişti; sayfayı yenileyin.',
    );
    expect(serviceIncidentErrorMessage('SOMETHING_NEW')).toBe('İşlem tamamlanamadı. Lütfen tekrar deneyin.');
    expect(serviceIncidentErrorMessage(undefined)).toBeNull();
    expect(reliabilityNotice('resolved')?.tone).toBe('success');
    expect(reliabilityNotice('RELIABILITY_REVIEW_ALREADY_RESOLVED')?.tone).toBe('error');
  });

  it('counts the response window in whole hours, never below one while open', () => {
    const now = new Date('2026-10-11T00:00:00.000Z');
    expect(hoursLeft('2026-10-12T12:00:00.000Z', now)).toBe(36);
    expect(hoursLeft('2026-10-11T00:10:00.000Z', now)).toBe(1);
    expect(hoursLeft('2026-10-10T00:00:00.000Z', now)).toBe(0);
  });
});

describe('permissions', () => {
  it('labels the five new permissions in their own areas', () => {
    expect(adminPermissionLabel('SERVICE_INCIDENTS_READ')).toEqual({ area: 'Hizmet aksaklıkları', action: 'okuma' });
    expect(adminPermissionLabel('SERVICE_INCIDENTS_ADJUDICATE')).toEqual({ area: 'Hizmet aksaklıkları', action: 'karar verme' });
    expect(adminPermissionLabel('SERVICE_INCIDENTS_CORRECT')).toEqual({
      area: 'Hizmet aksaklıkları',
      action: 'karar düzeltme (yalnız süper yönetici)',
    });
    expect(adminPermissionLabel('PROVIDER_RELIABILITY_READ')).toEqual({ area: 'Hizmet veren güvenilirliği', action: 'okuma' });
    expect(adminPermissionLabel('PROVIDER_RELIABILITY_MANAGE')).toEqual({
      area: 'Hizmet veren güvenilirliği',
      action: 'inceleme yönetimi',
    });
  });

  it('never offers a reserved permission to a role, and names it instead', () => {
    expect(
      grantablePermissions({
        permissions: ['SERVICE_INCIDENTS_READ', 'SERVICE_INCIDENTS_CORRECT'],
        reservedForSuperAdmin: ['SERVICE_INCIDENTS_CORRECT'],
      }),
    ).toEqual(['SERVICE_INCIDENTS_READ']);
    expect(grantablePermissions({ permissions: ['A'] })).toEqual(['A']);
    const note = html(<ReservedPermissionsNote reserved={['SERVICE_INCIDENTS_CORRECT']} />);
    expect(note).toContain('Yalnız süper yönetici');
    expect(note).toContain('<code>SERVICE_INCIDENTS_CORRECT</code>');
    expect(note).not.toContain('type="checkbox"');
    for (const path of ['app/roles/page.tsx', 'app/roles/[id]/page.tsx']) {
      expect(read(path)).toContain('groupPermissions(grantable)');
    }
  });

  it('puts both screens in the sidebar behind their read permission', () => {
    const rows = allNavItems();
    expect(rows.find((row) => row.href === '/service-incidents')).toMatchObject({
      label: 'Hizmet aksaklıkları',
      permission: 'SERVICE_INCIDENTS_READ',
    });
    expect(rows.find((row) => row.href === '/provider-reliability')).toMatchObject({
      label: 'Güvenilirlik',
      permission: 'PROVIDER_RELIABILITY_READ',
    });
  });

  it('gates the provider card, the decisions and the correction on their own permissions', () => {
    const provider = read('app/providers/[id]/page.tsx');
    expect(provider).toContain("can('PROVIDER_RELIABILITY_READ')");
    expect(provider).toContain("can('PROVIDER_RELIABILITY_MANAGE')");
    const detail = read('app/service-incidents/[id]/page.tsx');
    expect(detail).toMatch(/!decided && canAdjudicate \? \(\s*<IncidentAdjudicateForm/);
    expect(detail).toMatch(/decided && canCorrect && incident\.effective\.adjudicationId/);
    expect(detail).toContain("can('SERVICE_INCIDENTS_CORRECT')");
    // No suspension control anywhere on the reliability surfaces.
    for (const path of [
      'app/provider-reliability/page.tsx',
      'app/provider-reliability/review-actions.tsx',
      'app/providers/[id]/provider-reliability-card.tsx',
    ]) {
      expect(read(path)).not.toMatch(/ProviderStatusForm|SUSPENDED/);
    }
  });

  it('adds no loading.tsx above the new screens', () => {
    for (const path of ['app/service-incidents/loading.tsx', 'app/service-incidents/[id]/loading.tsx', 'app/provider-reliability/loading.tsx']) {
      expect(() => read(path)).toThrow();
    }
  });
});

describe('decision forms', () => {
  it('asks for a rationale and confirms each decision in a dialog', () => {
    const markup = html(<IncidentAdjudicateForm incidentId="si-1" action={noop} />);
    expect(markup).toMatch(/<textarea[^>]*required=""[^>]*minLength="10"[^>]*data-testid="incident-rationale"/);
    expect(markup).toMatch(/value="CONFIRMED"[^>]*data-testid="incident-confirm" name="decision"/);
    expect(markup).toMatch(/value="DISMISSED"[^>]*data-testid="incident-dismiss" name="decision"/);
    expect(markup.match(/data-testid="incident-decision-submit"/g)).toHaveLength(2);
    expect(markup).toContain('Otomatik kredi iadesi yok.');
  });

  it('corrects to the other decision against the current head', () => {
    const markup = html(
      <IncidentCorrectForm incidentId="si-1" current="CONFIRMED" effectiveAdjudicationId="adj-7" action={noop} />,
    );
    expect(markup).toContain('name="decision" value="DISMISSED"');
    expect(markup).toContain('name="expectedEffectiveAdjudicationId" value="adj-7"');
    expect(markup).toContain('data-testid="incident-correct"');
    expect(markup).toContain('data-testid="incident-rationale"');
  });
});

describe('reliability', () => {
  const view: ProviderReliabilityView = {
    provider: { id: 'p-1', businessName: 'Usta Klima', status: 'APPROVED' },
    summary: {
      windowDays: 90,
      windowStart: '2026-07-13T00:00:00.000Z',
      confirmed: 3,
      dismissed: 1,
      pending: 0,
      total: 4,
      responded: 2,
      responseRate: 0.5,
      lateResponses: 1,
      overdueResponses: 0,
      level: 'ADMIN_REVIEW_REQUIRED',
      thresholds: { warningAt: 2, reviewAt: 3 },
      openReview: {
        id: 'rv-1',
        providerId: 'p-1',
        status: 'OPEN',
        openedAt: '2026-10-10T10:00:00.000Z',
        openedBySystem: true,
        acknowledgedAt: null,
        resolvedAt: null,
        note: null,
        triggerIncident: { id: 'si-3', incidentNumber: 'SI-0003' },
        acknowledgedBy: null,
        resolvedBy: null,
      },
    },
    incidents: [
      {
        id: 'si-3',
        incidentNumber: 'SI-0003',
        status: 'CONFIRMED',
        reason: 'PROVIDER_NO_SHOW',
        reasonLabel: 'Hizmet veren gelmedi',
        reportedAt: '2026-10-09T10:00:00.000Z',
        inWindow: true,
        responseDueAt: '2026-10-12T10:00:00.000Z',
        respondedAt: null,
        roundNumber: 1,
        request: { id: 'r-1', requestNumber: 'TT-1' },
        adjudications: [
          { id: 'a-1', sequence: 1, kind: 'INITIAL', decision: 'CONFIRMED', createdAt: '2026-10-10T09:00:00.000Z', effective: true },
        ],
      },
    ],
    reviews: [],
  };

  it('draws the card with its anchor, level, count, banner and incident links', () => {
    const markup = html(
      <ProviderReliabilityCard view={view} canManage canOpenIncidents formActions={{ acknowledge: noop, resolve: noop }} />,
    );
    expect(markup).toContain('id="guvenilirlik"');
    expect(markup).toContain('data-testid="provider-reliability-card"');
    expect(markup).toMatch(/data-testid="reliability-level"[^>]*>Yönetici incelemesi gerekli</);
    expect(markup).toMatch(/data-testid="reliability-confirmed-count">3</);
    expect(markup).toContain('3 veya daha fazla doğrulanmış aksaklık — yönetici incelemesi gerekli');
    expect(markup).toContain('href="/service-incidents/si-3"');
    expect(markup).toContain('data-testid="review-acknowledge"');
    expect(markup).toContain('data-testid="review-resolve"');
    expect(markup).toContain('data-testid="review-note"');
  });

  it('shows no review controls without MANAGE, and none for a resolved review', () => {
    const markup = html(
      <ProviderReliabilityCard view={view} canManage={false} canOpenIncidents={false} formActions={{ acknowledge: noop, resolve: noop }} />,
    );
    expect(markup).not.toContain('review-acknowledge');
    expect(markup).not.toContain('href="/service-incidents/');
    expect(
      html(
        <ReviewActions
          review={{ id: 'rv-1', providerId: 'p-1', status: 'RESOLVED' }}
          providerName="Usta Klima"
          from="queue"
          formActions={{ acknowledge: noop, resolve: noop }}
        />,
      ),
    ).toBe('');
    const acknowledged = html(
      <ReviewActions
        review={{ id: 'rv-1', providerId: 'p-1', status: 'ACKNOWLEDGED' }}
        providerName="Usta Klima"
        from="queue"
        formActions={{ acknowledge: noop, resolve: noop }}
      />,
    );
    expect(acknowledged).not.toContain('review-acknowledge');
    expect(acknowledged).toContain('review-resolve');
  });
});
