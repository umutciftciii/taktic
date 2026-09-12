import type { ContactDisclosureConfig } from '../../lib/api';

/**
 * The contact-sharing disclosure, as both request forms show it.
 *
 * The checkbox states one thing only: that the linked text was read. It does
 * not paraphrase, summarise or stand in for that text — the disclosure itself
 * lives at CONTACT_DISCLOSURE_URL, and the feature cannot be switched on until
 * it does. The version travels with the form so a page filled in before a
 * wording change is caught by the API rather than recorded against the new
 * text.
 */
export function ContactDisclosureField({ disclosure }: { disclosure: ContactDisclosureConfig }) {
  return (
    <>
      <input type="hidden" name="contactDisclosureVersion" value={disclosure.disclosureVersion ?? ''} />
      <label className="checkbox-row" htmlFor="contact-disclosure">
        <input
          id="contact-disclosure"
          name="contactDisclosureAccepted"
          type="checkbox"
          value="true"
          required
          data-testid="contact-disclosure-accept"
        />
        <span>
          <a
            href={disclosure.disclosureUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
            data-testid="contact-disclosure-link"
          >
            İletişim bilgilerinin paylaşılmasına ilişkin bilgilendirme metnini
          </a>{' '}
          okudum.
        </span>
      </label>
    </>
  );
}
