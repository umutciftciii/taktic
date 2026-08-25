import { createServer, type IncomingMessage } from 'node:http';

/**
 * A stand-in for the Lemon Squeezy sandbox API.
 *
 * The browser suite has to exercise the real adapter, the real checkout
 * endpoint and the real redirect back — but it must never send a byte to Lemon
 * Squeezy, and there is no sandbox store it could legitimately open checkouts
 * against. So the API process under test is pointed at this server through
 * LEMON_SQUEEZY_API_BASE_URL, which the configuration reader only accepts for
 * loopback and only outside production.
 *
 * It answers two things and nothing else:
 *
 *   POST /v1/checkouts  the JSON:API response the adapter parses, with a hosted
 *                       URL on this same server.
 *   GET  /hosted/:id    a page that stands in for the payment provider's own
 *                       checkout, carrying a link back to the application's
 *                       return URL. It cannot settle anything: the suite loads
 *                       credits by posting a signed webhook, exactly as the
 *                       real provider would.
 *
 * No credential is checked here and none is needed — the point is that nothing
 * outside this process is contacted.
 */
const port = Number(process.env.LEMON_STUB_PORT ?? 3299);

type HostedCheckout = { redirectUrl: string };

const hosted = new Map<string, HostedCheckout>();
let sequence = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/checkouts') {
    readBody(request, (raw) => {
      let redirectUrl = '';
      try {
        const parsed = JSON.parse(raw) as {
          data?: { attributes?: { product_options?: { redirect_url?: string } } };
        };
        redirectUrl = parsed.data?.attributes?.product_options?.redirect_url ?? '';
      } catch {
        redirectUrl = '';
      }

      sequence += 1;
      const id = `stub-checkout-${sequence}`;
      hosted.set(id, { redirectUrl });

      response.writeHead(201, { 'content-type': 'application/vnd.api+json' });
      response.end(
        JSON.stringify({
          data: {
            type: 'checkouts',
            id,
            attributes: {
              url: `http://127.0.0.1:${port}/hosted/${id}`,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
          },
        }),
      );
    });
    return;
  }

  const hostedMatch = /^\/hosted\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (request.method === 'GET' && hostedMatch) {
    const checkout = hosted.get(hostedMatch[1] as string);

    if (!checkout) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('unknown checkout');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<title>Sandbox checkout</title></head><body>` +
        `<h1 data-testid="stub-checkout">Sandbox checkout</h1>` +
        `<a data-testid="stub-return" href="${escapeHtml(checkout.redirectUrl)}">Return</a>` +
        `</body></html>`,
    );
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ errors: [{ detail: 'not found' }] }));
});

function readBody(request: IncomingMessage, done: (raw: string) => void) {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[e2e] lemon squeezy stub listening on http://127.0.0.1:${port}`);
});
