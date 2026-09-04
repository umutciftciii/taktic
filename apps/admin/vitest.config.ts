import { defineConfig } from 'vitest/config';

/**
 * The admin panel's unit tests.
 *
 * `test/` only, and node rather than a DOM. What lives here is the pure
 * decision behind the dashboard — which metric is on a card, what it counts and
 * whether it earns a badge — which is a function of a summary object and needs
 * no rendering to check. Whether those cards then survive a 320px phone and a
 * real session is the end-to-end suite's question, and it drives the real
 * screens to answer it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
