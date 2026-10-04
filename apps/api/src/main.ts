import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { applyHttpSecurity } from './common/http-security';
import { assertBootConfig } from './boot-config';
import { UPLOAD_ROOT_DIR } from './modules/uploads/uploads.constants';

async function bootstrap() {
  // Every configuration check, before anything listens: an unusable
  // configuration is a startup failure rather than a surprise on the first
  // request that needs it. The list and the reasons live in boot-config.ts,
  // where the deploy preflight runs the same checks inside the image it is
  // about to start (boot-config-check.ts).
  assertBootConfig();

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

  // The security headers every response carries, the CORS allow-list, and the
  // `X-Powered-By` header this process no longer sends. Before the static file
  // handler below, so an uploaded image is answered with the same headers as an
  // endpoint. See common/http-security.ts.
  applyHttpSecurity(app);

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
