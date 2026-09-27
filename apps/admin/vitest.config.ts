import { defineConfig } from 'vitest/config';

/**
 * The admin panel's unit tests.
 *
 * `test/` only, and node rather than a DOM. What lives here is the pure
 * decision behind a screen — which metric is on a card, what it counts and
 * whether it earns a badge; which URL a tab, a filter or a page link writes;
 * which popover is open; whether a form is dirty — which is a function of its
 * inputs and needs no browser to check. The shared components are checked as
 * the static markup the server renders (`renderToStaticMarkup`), the way the
 * web app checks its own. Whether those screens then survive a 320px phone, a
 * keyboard and a real session is the end-to-end suite's question, and it
 * drives the real screens to answer it.
 *
 * The tsconfig leaves JSX to Next (`jsx: preserve`); the transform has to be
 * told to compile it here so a `.tsx` component can be imported at all.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
  },
});
