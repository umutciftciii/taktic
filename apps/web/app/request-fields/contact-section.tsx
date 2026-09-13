'use client';

import type { ReactNode } from 'react';

/**
 * The signed-in customer's own contact details, as the API reports them.
 *
 * Every field is nullable because every column is: an account may exist with no
 * telephone number or no name. The form reads them to *show* what will be
 * shared and to say when something is missing — it never posts them. On the
 * default path the API derives all three from the account itself, so what is
 * rendered here is a mirror, not an input.
 */
export type AccountContact = {
  name: string | null;
  phone: string | null;
  email: string | null;
};

export type AlternateContact = { name: string; phone: string; email: string };

/** An empty alternate contact — also what unticking the checkbox restores. */
export const EMPTY_ALTERNATE_CONTACT: AlternateContact = { name: '', phone: '', email: '' };

/** True when the account carries all three details the API needs. */
export function accountContactIsComplete(contact: AccountContact | null | undefined): boolean {
  return Boolean(contact?.name?.trim() && contact?.phone?.trim() && contact?.email?.trim());
}

/** Which of the three the account is missing, in the words the notice uses. */
export function missingAccountContactLabels(contact: AccountContact | null | undefined): string[] {
  return [
    contact?.name?.trim() ? null : 'ad soyad',
    contact?.phone?.trim() ? null : 'telefon',
    contact?.email?.trim() ? null : 'e-posta',
  ].filter((label): label is string => label !== null);
}

type ContactSectionProps = {
  /**
   * The signed-in customer's account contact, or null for a visitor with no
   * customer session. Null is what makes this the guest form: the three contact
   * fields are asked for, exactly as they always were.
   */
  accountContact: AccountContact | null;
  /**
   * Whether the customer asked to name somebody else, and what they typed.
   *
   * Controlled by the parent on purpose. The values have to be *erased* when
   * the box is unticked — not merely hidden — and an uncontrolled input that
   * React unmounts would leave the browser free to restore its text on the
   * next tick of the box. Holding them in state makes "cleared" a fact the form
   * owns, and the fields are gone from the DOM as well, so nothing is posted.
   */
  useAlternateContact: boolean;
  onUseAlternateContactChange: (value: boolean) => void;
  alternateContact: AlternateContact;
  onAlternateContactChange: (value: AlternateContact) => void;
  /**
   * The guest's own fields, controlled. The vitrin card's form keeps them in
   * state because the telephone number is proved inside the form and the
   * proof binds to the exact number typed; the marketplace form leaves this
   * undefined and the fields stay uncontrolled, exactly as they were.
   */
  guestContact?: AlternateContact;
  onGuestContactChange?: (value: AlternateContact) => void;
  /**
   * Rendered directly under the telephone number wherever one is typed, and
   * under the account summary when the number comes from the account. The
   * vitrin form puts its verification controls here; the marketplace form has
   * nothing to add.
   */
  phoneAddon?: ReactNode;
  /** Locks the typed number — after it has been proved, changing it would void the proof. */
  phoneLocked?: boolean;
  /** Wording under the e-mail field. */
  emailHelpText?: string;
  /**
   * Rendered directly under the guest e-mail field's label — the identity
   * pre-check's notice slot. Signed-in customers already have a resolved
   * identity, so this only ever shows up on the guest branch.
   */
  identityNotice?: ReactNode;
  /**
   * Fired on blur of the three guest fields only (not the signed-in
   * customer's alternate-contact fields) — the identity pre-check runs once
   * the visitor has finished typing rather than on every keystroke.
   */
  onContactBlur?: () => void;
};

/**
 * The contact section of a request form.
 *
 * There are two sources for a request's contact and the form never chooses
 * between them — the session does. A signed-in customer sees their account's
 * details and may name somebody else instead; everybody else types all three.
 * Shared by both request forms so the rule, the wording and the field names
 * are one thing.
 */
export function ContactSection({
  accountContact,
  useAlternateContact,
  onUseAlternateContactChange,
  alternateContact,
  onAlternateContactChange,
  guestContact,
  onGuestContactChange,
  phoneAddon,
  phoneLocked = false,
  emailHelpText = 'Tekliflerinizi takip edebilmeniz için e-posta adresiniz gereklidir.',
  identityNotice,
  onContactBlur,
}: ContactSectionProps) {
  if (!accountContact) {
    const controlled = guestContact !== undefined;
    const update = (patch: Partial<AlternateContact>) =>
      onGuestContactChange?.({ ...(guestContact ?? EMPTY_ALTERNATE_CONTACT), ...patch });

    return (
      <>
        <div className="form-grid">
          <label className="form-row">
            <span>Ad soyad *</span>
            <input
              name="customerName"
              autoComplete="name"
              required
              onBlur={onContactBlur}
              {...(controlled
                ? { value: guestContact.name, onChange: (e) => update({ name: e.target.value }) }
                : {})}
            />
          </label>
          <label className="form-row">
            <span>Telefon *</span>
            <input
              name="customerPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              // The identity pre-check will not ask about a number shorter than
              // this; saying so here lets the browser explain it on "Devam et"
              // instead of the step silently refusing to move.
              minLength={7}
              placeholder="05XX XXX XX XX"
              readOnly={phoneLocked}
              aria-readonly={phoneLocked || undefined}
              onBlur={onContactBlur}
              {...(controlled
                ? { value: guestContact.phone, onChange: (e) => update({ phone: e.target.value }) }
                : {})}
            />
          </label>
        </div>
        {phoneAddon}
        <label className="form-row">
          <span>E-posta *</span>
          <input
            name="customerEmail"
            type="email"
            autoComplete="email"
            required
            placeholder="ornek@eposta.com"
            onBlur={onContactBlur}
            {...(controlled
              ? { value: guestContact.email, onChange: (e) => update({ email: e.target.value }) }
              : {})}
          />
          <span className="help-text">{emailHelpText}</span>
        </label>
        {identityNotice}
      </>
    );
  }

  const complete = accountContactIsComplete(accountContact);

  return (
    <>
      {/*
        What the account already knows, shown rather than asked for. Read-only
        in the strongest sense available: this is text, not a disabled control,
        so there is no field for anyone to edit and nothing named `customerName`
        is posted. The API derives all three from the session on its side.
      */}
      {complete ? (
        <div className="verify-well" data-testid="account-contact-summary">
          <span className="cdash-summary-label">Hesap iletişim bilgileriniz</span>
          <dl className="account-contact-list">
            <div className="account-contact-row">
              <dt>Ad soyad</dt>
              <dd data-testid="account-contact-name">{accountContact.name}</dd>
            </div>
            <div className="account-contact-row">
              <dt>Telefon</dt>
              <dd data-testid="account-contact-phone">{accountContact.phone}</dd>
            </div>
            <div className="account-contact-row">
              <dt>E-posta</dt>
              <dd data-testid="account-contact-email">{accountContact.email}</dd>
            </div>
          </dl>
          <p className="help-text" style={{ margin: 0 }}>
            Teklifler bu iletişim bilgileriyle paylaşılacak.
          </p>
        </div>
      ) : (
        <div className="notice" data-testid="account-contact-incomplete">
          <span>
            Hesabınızda {missingAccountContactLabels(accountContact).join(', ')} bilgisi eksik olduğu
            için talebiniz hesap bilgilerinizle oluşturulamıyor. Aşağıdan farklı bir iletişim
            kişisi tanımlayabilirsiniz.
          </span>
        </div>
      )}

      {!useAlternateContact ? phoneAddon : null}

      <label className="checkbox-row" htmlFor="use-alternate-contact">
        <input
          id="use-alternate-contact"
          name="useAlternateContact"
          type="checkbox"
          value="true"
          checked={useAlternateContact}
          data-testid="use-alternate-contact"
          onChange={(event) => {
            onUseAlternateContactChange(event.target.checked);
            // Unticking erases what was typed. The next tick starts from empty
            // fields, and nothing lingers to be posted.
            if (!event.target.checked) {
              onAlternateContactChange(EMPTY_ALTERNATE_CONTACT);
            }
          }}
        />
        <span>Farklı bir iletişim kişisi kullanacağım</span>
      </label>
      <span className="help-text">Talep yine hesabınıza bağlı kalır; yalnız bu talep için iletişim kişisi değişir.</span>

      {useAlternateContact ? (
        <div className="alternate-contact-fields" data-testid="alternate-contact-fields">
          <p className="help-text">Bu bilgiler yalnızca bu talep için kullanılır; hesabınız değişmez.</p>
          <div className="form-grid">
            <label className="form-row">
              <span>Ad soyad *</span>
              <input
                name="customerName"
                required
                value={alternateContact.name}
                onChange={(event) =>
                  onAlternateContactChange({ ...alternateContact, name: event.target.value })
                }
              />
            </label>
            <label className="form-row">
              <span>Telefon *</span>
              <input
                name="customerPhone"
                type="tel"
                inputMode="tel"
                required
                placeholder="05XX XXX XX XX"
                readOnly={phoneLocked}
                aria-readonly={phoneLocked || undefined}
                value={alternateContact.phone}
                onChange={(event) =>
                  onAlternateContactChange({ ...alternateContact, phone: event.target.value })
                }
              />
            </label>
          </div>
          {phoneAddon}
          <label className="form-row">
            <span>E-posta *</span>
            <input
              name="customerEmail"
              type="email"
              required
              placeholder="ornek@eposta.com"
              value={alternateContact.email}
              onChange={(event) =>
                onAlternateContactChange({ ...alternateContact, email: event.target.value })
              }
            />
            <span className="help-text">
              Teklifler bu kişiyle paylaşılacak. Talep yine hesabınıza bağlı kalır.
            </span>
          </label>
        </div>
      ) : null}
    </>
  );
}
