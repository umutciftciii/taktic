import {
  BusinessRegistrationType,
  type Prisma,
  type ProviderBusinessRegistrationActor,
} from '@prisma/client';
import { maskRegistrationNumber, type NormalizedBusinessRegistration } from './business-registration.rules';
import { businessRegistrationFingerprint } from './promotion-fingerprint';

/**
 * The one writer of ProviderBusinessRegistration (CMP-006 PR-C), on the
 * caller's transaction: the application paths (open and invited) and the
 * provider's own company-information route all come through here, so the
 * mask, the fingerprint and the history row cannot drift between them.
 *
 * Writing the same declaration again (same type, same fingerprint) changes
 * nothing and adds no history row. Every real change appends one
 * ProviderBusinessRegistrationChange carrying types and fingerprints only.
 */
export async function writeBusinessRegistration(
  tx: Prisma.TransactionClient,
  input: {
    providerId: string;
    declaration: NormalizedBusinessRegistration;
    actorKind: ProviderBusinessRegistrationActor;
    actorUserId: string | null;
  },
): Promise<{ changed: boolean; view: BusinessRegistrationView }> {
  const { declaration } = input;
  const derived =
    declaration.type === BusinessRegistrationType.NONE_DECLARED
      ? { numberCanonical: null, numberMasked: null, fingerprint: null, fingerprintVersion: null }
      : {
          numberCanonical: declaration.numberCanonical,
          numberMasked: maskRegistrationNumber(declaration.numberCanonical),
          ...businessRegistrationFingerprint(declaration.type, declaration.numberCanonical),
        };

  const previous = await tx.providerBusinessRegistration.findUnique({
    where: { providerId: input.providerId },
    select: { type: true, fingerprint: true, fingerprintVersion: true, numberMasked: true, updatedAt: true },
  });
  if (
    previous &&
    previous.type === declaration.type &&
    previous.fingerprint === derived.fingerprint &&
    previous.fingerprintVersion === derived.fingerprintVersion
  ) {
    return { changed: false, view: registrationView(previous) };
  }

  const row = await tx.providerBusinessRegistration.upsert({
    where: { providerId: input.providerId },
    create: {
      providerId: input.providerId,
      type: declaration.type,
      ...derived,
      declaredByUserId: input.actorUserId,
    },
    update: { type: declaration.type, ...derived, declaredByUserId: input.actorUserId },
    select: { type: true, numberMasked: true, updatedAt: true },
  });
  await tx.providerBusinessRegistrationChange.create({
    data: {
      providerId: input.providerId,
      actorKind: input.actorKind,
      actorUserId: input.actorUserId,
      previousType: previous?.type ?? null,
      previousFingerprint: previous?.fingerprint ?? null,
      previousFingerprintVersion: previous?.fingerprintVersion ?? null,
      newType: declaration.type,
      newFingerprint: derived.fingerprint,
      newFingerprintVersion: derived.fingerprintVersion,
    },
  });
  return { changed: true, view: registrationView(row) };
}

/**
 * What any response may carry about a registration: the type and the masked
 * number. `UNSPECIFIED` is a provider with no row — every profile from before
 * this table, reported honestly as a legacy record.
 */
export type BusinessRegistrationView = {
  status: 'DECLARED' | 'NONE_DECLARED' | 'UNSPECIFIED';
  type: BusinessRegistrationType | null;
  numberMasked: string | null;
  updatedAt: Date | null;
};

export function registrationView(
  row: { type: BusinessRegistrationType; numberMasked: string | null; updatedAt: Date } | null | undefined,
): BusinessRegistrationView {
  if (!row) {
    return { status: 'UNSPECIFIED', type: null, numberMasked: null, updatedAt: null };
  }
  return {
    status: row.type === BusinessRegistrationType.NONE_DECLARED ? 'NONE_DECLARED' : 'DECLARED',
    type: row.type,
    numberMasked: row.numberMasked,
    updatedAt: row.updatedAt,
  };
}

/** The select every provider projection uses for the relation — never the raw number. */
export const businessRegistrationMaskedSelect = {
  select: { type: true, numberMasked: true, updatedAt: true },
} satisfies Prisma.ProviderProfile$businessRegistrationArgs;
