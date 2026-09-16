import { defineConfig } from 'vitest/config';

/**
 * The web app's unit tests.
 *
 * `test/` only, and node rather than a DOM: what lives here is the cookie the
 * server hands the browser, which is decided entirely on the server, and the
 * static markup a few presentational components render — checked as a string,
 * the way the server produces it. Everything this app does in a browser is
 * covered by the end-to-end suite driving the real screens, which is a better
 * witness than a simulated DOM would be.
 *
 * The tsconfig leaves JSX to Next (`jsx: preserve`); the transform has to be
 * told to compile it here so a `.tsx` component can be imported at all.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
