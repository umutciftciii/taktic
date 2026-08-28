import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertSessionPolicyConfig } from './modules/auth/auth.constants';
import { assertContactSharingConfig } from './modules/contact-sharing/contact-sharing.config';
import { assertEmailBrandingConfig } from './modules/notifications/email-branding.config';
import { assertEmailTransportConfig } from './modules/notifications/email-transport';
import { assertPaymentProviderConfig } from './modules/payments/payment-provider.config';
import { assertProviderClaimConfig } from './modules/provider-claim/provider-claim.config';
import { UPLOAD_ROOT_DIR } from './modules/uploads/uploads.constants';

async function bootstrap() {
  // The public base URL is deliberately NOT checked here.
  //
  // It used to be, and the blast radius was wrong: a base URL that is unusable
  // in an e-mail took down authentication, the admin panel and every request
  // and offer flow with it. Whether a link can be clicked by a stranger is a
  // question about one message, so it is asked once per send by the delivering
  // transport, which refuses that message and records it as FAILED. See
  // common/public-urls.ts.

  // The company footer is no longer a boot condition. Its three values — legal
  // name, support address, postal address — are business facts an operator
  // maintains from the admin panel (CompanySettings), so a missing one must not
  // take a marketplace offline: the delivering transport refuses that one
  // message with EMAIL_BRANDING_INCOMPLETE instead, and the admin screen says
  // what is missing. This call only rejects a *deprecated* SUPPORT_EMAIL that
  // is set to something which is not an address at all.
  assertEmailBrandingConfig();

  // The session policy, before anything can sign in. A duration that is not a
  // positive whole number of seconds is a security decision made by accident —
  // a typo reading as zero would end every session on the next request — so it
  // stops the process rather than silently restoring a default nobody chose.
  assertSessionPolicyConfig();

  // Before anything listens. Turning contact sharing on without a disclosure
  // URL and version must stop the process rather than degrade into a state
  // where customers are asked to confirm having read nothing.
  assertContactSharingConfig();

  // The outbound transport, before the first message is ever composed. A
  // production process wired to the console adapter would log "not delivered"
  // for every activation link while looking perfectly healthy, and one wired to
  // Resend without a key would discover that on the first send — as a FAILED
  // audit row nobody is watching at the time.
  assertEmailTransportConfig();

  // Same reasoning, one flag over. A production process that offers to mail
  // claim links while nothing can actually deliver e-mail would hand out
  // ownership invitations no applicant ever receives, so it must not start.
  assertProviderClaimConfig();

  // The payment provider, before a single checkout can be opened. An
  // unrecognised PAYMENT_PROVIDER, a sandbox provider in production, or any
  // environment variable that could only mean "start taking real money" all
  // stop the process here rather than surfacing as a purchase that loaded
  // credits nobody paid for.
  assertPaymentProviderConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Keeps the untouched request bytes on `req.rawBody`. The payment webhook
    // verifies an HMAC over exactly those bytes; a re-serialised body would
    // differ in whitespace and key order and make every genuine delivery look
    // forged.
    rawBody: true,
  });

  // Rate limiting keys off req.ip. Express only derives that from
  // X-Forwarded-For when `trust proxy` is on, so it stays off unless the
  // deployment explicitly declares how many proxies sit in front of the API
  // (TRUST_PROXY=1 for a single load balancer). Without this, any client could
  // forge the header and bypass the auth throttle.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    const hops = Number(trustProxy);
    app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : trustProxy);
  }

  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useStaticAssets(UPLOAD_ROOT_DIR, { prefix: '/uploads/' });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
