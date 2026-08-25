import { Controller, Headers, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { LEMON_SQUEEZY_SIGNATURE_HEADER } from './lemon-squeezy.webhook';
import { PaymentsWebhookService } from './payments-webhook.service';

/**
 * The public settlement endpoint.
 *
 * Deliberately unauthenticated in the session sense — the payment provider has
 * no cookie — and deliberately guarded by something stronger: an HMAC over the
 * exact bytes received. `req.rawBody` is populated because main.ts (and the
 * test harness) boot Nest with `rawBody: true`; verifying a re-serialised body
 * would fail on whitespace and key order alone.
 *
 * The handler answers 200 for every delivery the provider is entitled to
 * consider handled — settled, redelivered, unhandled, or refused as
 * inconsistent — so a genuine store is never put into a retry loop by a payload
 * this application will never accept. The two exceptions are the ones a caller
 * can act on: 401 for a bad signature and 400 for bytes that are not a payload.
 * Neither writes anything.
 *
 * The response body is a single status word. It never states what was wrong,
 * because the endpoint is public.
 */
@Controller()
export class LemonSqueezyWebhookController {
  constructor(
    @Inject(PaymentsWebhookService) private readonly webhooks: PaymentsWebhookService,
  ) {}

  @Post('payments/lemon-squeezy/webhook')
  @HttpCode(HttpStatus.OK)
  handleDelivery(
    @Req() request: RawBodyRequest,
    @Headers(LEMON_SQUEEZY_SIGNATURE_HEADER) signature?: string,
  ) {
    return this.webhooks.handleLemonSqueezyDelivery(request.rawBody, signature);
  }
}

/**
 * The one field this handler reads off the request. Declared structurally
 * rather than imported from Express, so the controller stays independent of the
 * HTTP adapter's type packages.
 */
type RawBodyRequest = { rawBody?: Buffer };
