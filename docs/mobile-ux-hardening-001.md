# MOBILE-UX-HARDENING-001 — public, auth and request layouts on a phone

Scope: the shared public shell (header, footer), the auth frame and every
screen that uses it, the public category screen and its request form. No API,
business-logic or schema change; no migration.

## Mobile hierarchy

Transactional screens put the person's actual task first:

```
Header (one row) → form / result / action → short supporting content → Footer
```

| Screen | First content under the header | After it |
| --- | --- | --- |
| `/login` | "Tekrar hoş geldin" + form | compact poster band |
| `/register/customer`, `/register/provider` | "Hesap oluştur" + form | compact poster band |
| `/e-posta-dogrula` (ok / invalid) | result heading + CTA | compact poster band |
| `/sifre-unuttum`, `/sifre-sifirla` (form / sent / done / invalid) | form or result + CTA | compact poster band |
| `/categories/[slug]` | breadcrumb, title, short head, step tabs, first step | quality rail, editorial |

## Breakpoints

| Width | Header | Auth frame | Footer | Request form |
| --- | --- | --- | --- | --- |
| ≥ 900px | desktop row: logo, links, actions (unchanged) | two equal columns, poster left (grid placement) | five columns (unchanged) | unchanged |
| 640–899px | one row; links behind "Menü"; Giriş + Talep Oluştur in the bar | single column, form first, compact poster | two columns (unchanged) | unchanged |
| < 640px | one row: logo, icon toggle, one action; "Giriş yap" moves into the menu; signed-in account shows initials only | as above; poster list hidden, title 22px, form title 26px | brand + four folded groups + legal row | head illustration hidden, tabs on one row ("Adım" visually hidden), back/next side by side |

The existing 16px gutter below 640px (`--wrap-pad`) is the page padding for
every element changed here; no new spacing token was introduced.

## Auth layout decision

`AuthFrame` renders the form section **before** the poster in the DOM and the
poster is an `<aside aria-label="TakTick hesabı">`. Narrow screens follow the
source order; from 900px `.auth-screen-split` is a two-column grid that places
the poster in column 1 and the form in column 2. Screen readers read the same
order on every width, and the page's `<h1>` precedes the poster's `<h2>`.

Poster on a phone: kept (not hidden) as a compact band after the task —
kicker, a 22px title and the one-sentence sub; the three-point list is hidden
because it repeats the sentence. Desktop poster is unchanged.

The no-poster auth screens (`/activate-customer`) use `.auth-screen` without
the `-split` modifier and are not affected.

## Header rules

- `SiteMenu` (client, one boolean) wraps the server-rendered `<nav>`. On
  desktop the wrapper and panel are `display: contents` and the toggle is not
  rendered, so the row is exactly what it was.
- Below 900px: disclosure pattern — `aria-expanded` / `aria-controls`, Escape
  closes and returns focus to the toggle, outside pointer-down closes, following
  a link (including a same-page hash) closes, route change closes, crossing to
  desktop closes. No focus trap or scroll lock: the panel does not cover the
  page.
- Toggle and menu links are ≥ 44px tall. Accessible name "Menü" (visually
  hidden below 640px).
- Staff accounts have no public links and get no toggle.
- The account menu (`.lp-user`) stays in the bar at every width.

## Footer rules

- `FooterGroup` (client, one boolean) renders an `<h2>` (desktop) and a button
  (phone) for each group; CSS shows one, so neither width announces both. The
  link list is rendered once.
- Below 640px groups start collapsed; the bottom row's legal links
  (`<nav aria-label="Yasal">`) never fold.
- Desktop footer unchanged.

## Fixed / sticky audit

Public, auth and request screens have no sticky or fixed bars. The only fixed
elements are modal overlays (start-choice modal, idle-session warning) and the
panel drawer (panel routes only). The request form's buttons stay in the flow
on purpose: nothing can sit on top of the on-screen keyboard or the browser's
own toolbar, so no safe-area inset is needed.

## Tested viewport matrix

| Viewport | Checked |
| --- | --- |
| 320 × 568 | E2E: login, header menu, request form, HYBRID selector, footer, overflow sweep; screenshots |
| 360 × 800 | E2E: login, header menu, request form, overflow sweep |
| 375 × 812 | E2E: login, verification result, register, header, request form + back/next, footer, sweep; screenshots |
| 390 × 844 | E2E: login, header menu, request form, overflow sweep |
| 430 × 932 | E2E: login, header, request form, sweep; screenshots |
| 768 × 1024 | manual browser check (single-column auth, compact header) |
| 1280 × 900 | E2E desktop composition; metrics identical to `main` |

E2E: `e2e/tests/mobile-public-shell.spec.ts` (Chromium and WebKit). Overflow is
`scrollWidth <= clientWidth` on the document; no `overflow-x: hidden` was added
anywhere to hide a symptom. Screenshots land in
`e2e/.artifacts/mobile-shell/`.

Unit: `apps/web/test/mobile-shell.spec.tsx` (source order, landmarks, footer
groups).
