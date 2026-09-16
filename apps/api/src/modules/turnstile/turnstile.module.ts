import { Global, Module } from '@nestjs/common';
import { CloudflareTurnstileVerifier } from './cloudflare-turnstile.verifier';
import { OffTurnstileVerifier } from './off-turnstile.verifier';
import { TestTurnstileVerifier } from './test-turnstile.verifier';
import { TurnstileReplayCache } from './turnstile-replay.cache';
import { resolveTurnstileConfig } from './turnstile.config';
import { TurnstileGuard } from './turnstile.guard';
import { TurnstileVerifierPort } from './turnstile-verifier.port';

/**
 * Binds the verifier the guard asks, once, from the process's environment.
 *
 * Global because the guard is used from four feature modules and none of
 * them should have to know which verifier is behind it. The factory throws
 * when the configuration is wrong, which is a boot failure — main.ts asks
 * the same question first (assertTurnstileConfig) so the message is the
 * first line of the log rather than buried in Nest's dependency trace.
 */
@Global()
@Module({
  providers: [
    {
      provide: TurnstileVerifierPort,
      useFactory: (): TurnstileVerifierPort => {
        const config = resolveTurnstileConfig();
        switch (config.mode) {
          case 'cloudflare':
            return new CloudflareTurnstileVerifier(config);
          case 'test':
            return new TestTurnstileVerifier();
          case 'off':
            return new OffTurnstileVerifier();
        }
      },
    },
    { provide: TurnstileReplayCache, useFactory: () => new TurnstileReplayCache() },
    TurnstileGuard,
  ],
  exports: [TurnstileVerifierPort, TurnstileReplayCache, TurnstileGuard],
})
export class TurnstileModule {}
