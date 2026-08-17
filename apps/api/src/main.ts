import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { UPLOAD_ROOT_DIR } from './modules/uploads/uploads.constants';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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
