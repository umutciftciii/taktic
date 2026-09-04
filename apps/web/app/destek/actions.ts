'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '@taktic/shared';
import { apiUrl, readApiMessage } from '../api-base';

/**
 * Opening a ticket and replying to one, as server actions.
 *
 * Both forms are real forms: they work before JavaScript has loaded and they
 * work if it never loads. The client components around them add a counter and a
 * pending state, and nothing else — the write itself is here.
 *
 * Every refusal comes back as a value rather than an exception. A message that
 * was too long, a ticket that has closed under the writer, an expired session:
 * these are things somebody needs to read on the screen they are already on,
 * not on the generic error boundary. What was typed comes back with the
 * refusal, so a rejected send never also destroys the draft.
 *
 * Neither action carries a ticket owner, an author or a status, and neither
 * could: the API takes the owner from the session and the ticket from the path.
 */

export type SupportTicketFormState = {
  status: 'idle' | 'error';
  /** Shown verbatim; the API writes these in Turkish for exactly this purpose. */
  message?: string;
  /** Kept so a refused submission does not also lose what was typed. */
  subject?: string;
  body?: string;
};

export async function createSupportTicketAction(
  _previous: SupportTicketFormState,
  formData: FormData,
): Promise<SupportTicketFormState> {
  const subject = readString(formData, 'subject');
  const message = readString(formData, 'message');

  // The same two checks the API makes, in the same order, so the obvious
  // mistakes are answered without a round trip. They are a courtesy, not the
  // rule: the server repeats both, and it is the only side that can enforce
  // them.
  if (!subject.trim()) {
    return { status: 'error', message: 'Konu boş olamaz.', subject, body: message };
  }

  if (subject.length > SUPPORT_TICKET_SUBJECT_MAX_LENGTH) {
    return {
      status: 'error',
      message: `Konu en fazla ${SUPPORT_TICKET_SUBJECT_MAX_LENGTH} karakter olabilir.`,
      subject,
      body: message,
    };
  }

  if (!message.trim()) {
    return { status: 'error', message: 'Mesaj boş olamaz.', subject, body: message };
  }

  if (message.length > SUPPORT_TICKET_MESSAGE_MAX_LENGTH) {
    return {
      status: 'error',
      message: `Mesaj en fazla ${SUPPORT_TICKET_MESSAGE_MAX_LENGTH} karakter olabilir.`,
      subject,
      body: message,
    };
  }

  let response: Response;
  try {
    response = await supportFetch('/support/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject, message }),
    });
  } catch {
    return {
      status: 'error',
      message: 'Destek talebi oluşturulamadı. Bağlantınızı kontrol edip tekrar deneyin.',
      subject,
      body: message,
    };
  }

  if (!response.ok) {
    return {
      status: 'error',
      message: (await readApiMessage(response)) ?? refusalFor(response.status),
      subject,
      body: message,
    };
  }

  const created = (await response.json()) as { id?: unknown };
  const ticketId = typeof created.id === 'string' ? created.id : null;

  if (!ticketId) {
    // The write landed; only the id did not come back. Sending them to the list
    // rather than to a guessed URL is the honest version — the ticket is there.
    revalidatePath('/destek');
    redirect('/destek?created=1');
  }

  revalidatePath('/destek');
  redirect(`/destek/${ticketId}?created=1`);
}

export async function replySupportTicketAction(
  _previous: SupportTicketFormState,
  formData: FormData,
): Promise<SupportTicketFormState> {
  const ticketId = readString(formData, 'ticketId');
  const body = readString(formData, 'body');

  if (!ticketId) {
    return { status: 'error', message: 'Bu destek talebi bulunamadı.', body };
  }

  if (!body.trim()) {
    return { status: 'error', message: 'Mesaj boş olamaz.', body: '' };
  }

  if (body.length > SUPPORT_TICKET_MESSAGE_MAX_LENGTH) {
    return {
      status: 'error',
      message: `Mesaj en fazla ${SUPPORT_TICKET_MESSAGE_MAX_LENGTH} karakter olabilir.`,
      body,
    };
  }

  let response: Response;
  try {
    response = await supportFetch(`/support/tickets/${encodeURIComponent(ticketId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  } catch {
    return {
      status: 'error',
      message: 'Mesaj gönderilemedi. Bağlantınızı kontrol edip tekrar deneyin.',
      body,
    };
  }

  if (!response.ok) {
    return {
      status: 'error',
      message: (await readApiMessage(response)) ?? refusalFor(response.status),
      body,
    };
  }

  // The ticket screen re-reads its timeline on the server, so the sent message
  // is on the page after this action even with scripting off.
  revalidatePath(`/destek/${ticketId}`);
  revalidatePath('/destek');
  redirect(`/destek/${ticketId}?sent=1`);
}

async function supportFetch(path: string, init: RequestInit): Promise<Response> {
  const cookieHeader = (await cookies()).toString();
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: cookieHeader, ...init.headers },
    cache: 'no-store',
  });
}

/**
 * A sentence for a status the API did not write one for.
 *
 * Only ever a fallback — the API's own message is preferred, because it is the
 * one that knows which rule was broken.
 */
function refusalFor(status: number): string {
  if (status === 401) {
    return 'Oturumunuz sona ermiş olabilir. Lütfen tekrar giriş yapın.';
  }

  if (status === 403 || status === 404) {
    return 'Bu destek talebine artık erişiminiz yok.';
  }

  if (status === 409) {
    return 'Bu destek talebi kapandığı için yeni mesaj eklenemiyor. Yeni bir talep açabilirsiniz.';
  }

  return 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
