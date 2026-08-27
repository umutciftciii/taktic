/**
 * Where the server components and server actions reach the API.
 *
 * The same three-step resolution every route in this app already used, lifted
 * into one module so a new page cannot quietly pick a different default.
 */
export const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function readApiMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed?.message === 'string') {
        return parsed.message;
      }
      if (Array.isArray(parsed?.message) && typeof parsed.message[0] === 'string') {
        return parsed.message[0];
      }
    } catch {
      return text;
    }

    return null;
  } catch {
    return null;
  }
}
