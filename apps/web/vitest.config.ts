import { defineConfig } from 'vitest/config';

/**
 * The web app's unit tests.
 *
 * `test/` only, and node rather than a DOM: what lives here is the cookie the
 * server hands the browser, which is decided entirely on the server. Everything
 * this app does in a browser is covered by the end-to-end suite driving the
 * real screens, which is a better witness than a simulated DOM would be.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
