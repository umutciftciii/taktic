import { describe, expect, it } from 'vitest';
import {
  afterVerificationSentence,
  noOffersYetText,
  phoneVerificationCardCopy,
  requestSummaryBody,
  requestTimelineSteps,
} from '../lib/request-lifecycle';

/**
 * The request detail's own words while the request waits for the customer's
 * proof of their telephone number — and, just as important, its words when it
 * does not.
 *
 * `awaitingPhoneVerification` is the API's explicit signal; nothing here reads
 * it out of the status column. The publish-or-review sentence follows the
 * same fail-closed policy read the request form uses.
 */

const base = {
  status: 'SUBMITTED',
  offersCount: 0,
  submittedAt: '2026-09-17T10:00:00.000Z',
  expiredAt: null,
  awaitingPhoneVerification: false,
};

const waiting = { ...base, awaitingPhoneVerification: true };

function titles(steps: ReturnType<typeof requestTimelineSteps>) {
  return steps.map((step) => step.title);
}

describe('the summary sentence', () => {
  it('says the request has not reached anybody yet while it waits for the customer', () => {
    const text = requestSummaryBody(waiting, true).toLowerCase();
    expect(text).toContain('henüz hizmet verenlere iletilmedi');
    expect(text).toContain('doğrula');
    expect(text).not.toContain('iletildi.');
    expect(text).not.toContain('ön incele');
  });

  it('names the review after verification when instant publish is off', () => {
    const text = requestSummaryBody(waiting, false).toLowerCase();
    expect(text).toContain('henüz hizmet verenlere iletilmedi');
    expect(text).toContain('ön incelemeye alınır');
  });

  it('keeps a SUBMITTED request that is not waiting on the customer in review wording', () => {
    const text = requestSummaryBody(base, true).toLowerCase();
    expect(text).toContain('ön inceleme');
    expect(text).not.toContain('doğrula');
    expect(text).not.toContain('iletildi.');
  });

  it('tells an APPROVED request it has reached providers, as before', () => {
    expect(requestSummaryBody({ ...base, status: 'APPROVED' }, false)).toContain(
      'Talebiniz hizmet verenlere iletildi.',
    );
  });
});

describe('the timeline', () => {
  it('shows a pending verification step and no review step under instant publish', () => {
    const steps = requestTimelineSteps(waiting, true);
    expect(titles(steps)).toEqual(['Talep alındı', 'Telefon doğrulama', 'Teklif toplama', 'Eşleşme']);
    expect(steps[1]).toMatchObject({ done: false, meta: 'Sizi bekliyor' });
    expect(steps[0]!.done).toBe(true);
  });

  it('puts the review after the verification when instant publish is off', () => {
    const steps = requestTimelineSteps(waiting, false);
    expect(titles(steps)).toEqual([
      'Talep alındı',
      'Telefon doğrulama',
      'Ön inceleme',
      'Teklif toplama',
      'Eşleşme',
    ]);
    expect(steps[1]!.done).toBe(false);
    expect(steps[2]!.done).toBe(false);
  });

  it('is unchanged for a request that is not waiting on the customer', () => {
    expect(titles(requestTimelineSteps(base, true))).toEqual([
      'Talep alındı',
      'Ön inceleme',
      'Teklif toplama',
      'Eşleşme',
    ]);
    const approved = requestTimelineSteps({ ...base, status: 'APPROVED', offersCount: 2 }, true);
    expect(approved[1]).toMatchObject({ title: 'Ön inceleme', done: true });
    expect(approved[2]).toMatchObject({ title: 'Teklif toplama', done: true, meta: '2 teklif' });
    expect(approved[3]).toMatchObject({ title: 'Eşleşme', done: false });
  });

  it('names the publication, not a review, on a request that went live with nobody moderating it', () => {
    // Born live on the account's proven number, or published by the customer's
    // own verification: approved, never moderated.
    const bornLive = requestTimelineSteps(
      { ...base, status: 'APPROVED', approvedAt: '2026-09-17T10:00:00.000Z', moderatedAt: null },
      true,
    );
    expect(titles(bornLive)).toEqual(['Talep alındı', 'Yayına alındı', 'Teklif toplama', 'Eşleşme']);
    expect(bornLive[1]!.done).toBe(true);

    // The same wording with the switch off: it is the row that says so, not the policy.
    expect(
      requestTimelineSteps(
        { ...base, status: 'APPROVED', approvedAt: '2026-09-17T10:00:00.000Z', moderatedAt: null },
        false,
      )[1]!.title,
    ).toBe('Yayına alındı');
  });

  it('keeps the review step for a request an operator moderated', () => {
    const moderated = requestTimelineSteps(
      {
        ...base,
        status: 'APPROVED',
        approvedAt: '2026-09-17T10:00:00.000Z',
        moderatedAt: '2026-09-17T10:00:00.000Z',
      },
      true,
    );
    expect(moderated[1]).toMatchObject({ title: 'Ön inceleme', done: true });
    // Older answers without the two timestamps read as they always did.
    expect(requestTimelineSteps({ ...base, status: 'APPROVED' }, true)[1]).toMatchObject({
      title: 'Ön inceleme',
      done: true,
    });
  });

  it('renders placeholders and nothing done when the summary is missing', () => {
    const steps = requestTimelineSteps(null, true);
    expect(titles(steps)).toEqual(['Talep alındı', 'Ön inceleme', 'Teklif toplama', 'Eşleşme']);
    expect(steps.every((step) => step.done === (step.title === 'Talep alındı'))).toBe(true);
  });
});

describe('the verification card', () => {
  it('demands the proof, and says what it leads to, when the request waits for it', () => {
    const on = phoneVerificationCardCopy({ required: true, maskedPhone: '905*******01', autoPublishEnabled: true });
    expect(on).toContain('905*******01');
    expect(on).toContain('gerekiyor');
    expect(on).toContain(afterVerificationSentence(true));
    expect(on).not.toContain('zorunlu değildir');

    const off = phoneVerificationCardCopy({ required: true, maskedPhone: '905*******01', autoPublishEnabled: false });
    expect(off).toContain(afterVerificationSentence(false));
  });

  it('only invites while verification changes nothing', () => {
    const copy = phoneVerificationCardCopy({ required: false, maskedPhone: '905*******01', autoPublishEnabled: true });
    expect(copy).toContain('zorunlu değildir');
    expect(copy).not.toContain('gerekiyor');
  });
});

describe('the empty offers box', () => {
  it('does not claim the request reached anybody while it waits for the customer', () => {
    const text = noOffersYetText(waiting).toLowerCase();
    expect(text).not.toContain('ulaştı');
    expect(text).toContain('doğrula');
  });

  it('names the review for a request waiting on an operator', () => {
    const text = noOffersYetText(base).toLowerCase();
    expect(text).not.toContain('ulaştı');
    expect(text).toContain('ön inceleme');
  });

  it('keeps the reached-providers sentence for a live request', () => {
    expect(noOffersYetText({ ...base, status: 'APPROVED' })).toBe(
      'Talebiniz hizmet verenlere ulaştı. Teklifler geldikçe burada görüntülenecektir.',
    );
    expect(noOffersYetText(null)).toBe(
      'Talebiniz hizmet verenlere ulaştı. Teklifler geldikçe burada görüntülenecektir.',
    );
  });
});
