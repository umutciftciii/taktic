import { EmailBranding } from './email-branding.config';
import { NotificationMessage } from './notification.port';
import { renderTransactionalEmail } from './templates/transactional-templates';

/**
 * Renders the plain-text and HTML bodies a delivering transport sends.
 *
 * There is one renderer now. Every message this application sends is a document
 * in the TakTick e-mail design system (see templates/email-design.ts) — a 600px
 * table-based card with every style inline, a logo and the company footer.
 *
 * It used to be two. A separate plain renderer lived here for the three
 * templates that predate the design system — the guest activation link, the
 * provider claim invitation and the day-7 request reminder — on the reasoning
 * that re-skinning them was a product decision rather than a side effect of
 * adding the new set. That decision has since been taken: the three are
 * documents in transactional-templates.ts like everything else, with their
 * wording, their variables, their links and their expiry semantics unchanged.
 *
 * The two rules the renderer enforces are unchanged as well. There is no
 * marketing block, no unsubscribe funnel and no tracking pixel; and every
 * interpolated value is escaped for the HTML body, because the values come from
 * customer- and applicant-supplied fields (a business name, an offer note) and
 * treating them as markup would be a stored-XSS sink in whatever client renders
 * the mail.
 */
export type RenderedEmail = {
  text: string;
  html: string;
};

/**
 * `branding` is required, with no degraded path.
 *
 * Every template prints the company footer, so a caller that could not resolve
 * the admin-managed settings has to refuse the send rather than render half a
 * message — which is what the delivering adapter does. A null reaching here is
 * a programming error, not a state to degrade into.
 *
 * This now covers the three formerly-plain templates too. They print the footer
 * like everything else, so they are gated like everything else — the same rule
 * the password reset has always followed, and for the same reason: a recipient
 * must never be told to write to a placeholder support address.
 */
export function renderEmail(
  message: NotificationMessage,
  branding: EmailBranding | null,
): RenderedEmail {
  if (!branding) {
    throw new Error(
      `renderEmail(${message.template}) requires resolved branding: every template prints the ` +
        'company footer.',
    );
  }

  const rendered = renderTransactionalEmail(message.template, message, branding);
  return { text: rendered.text, html: rendered.html };
}
