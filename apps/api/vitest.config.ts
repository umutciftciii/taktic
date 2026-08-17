import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // esbuild (Vitest's default transformer) cannot emit decorator metadata.
    // NestJS's ValidationPipe reads `design:paramtypes` to find a handler's DTO
    // type; without it the pipe silently skips validation and the tests would
    // stop reflecting production behaviour. SWC emits that metadata.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true, legacyDecorator: true },
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Integration tests share one PostgreSQL database and truncate between
    // cases, so files must not run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
