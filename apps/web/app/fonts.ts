import localFont from 'next/font/local';

/**
 * Archivo, served from this repository (CI-FONTS-001). The build reads no font
 * from the network: `next/font/google` fetched these files from Google at build
 * time, so a CI runner without that access could not build the site at all.
 *
 * The three files under `assets/fonts/archivo` are the exact files Google Fonts
 * served for `Archivo({ subsets: ['latin', 'latin-ext'], weight: ['400', '600',
 * '800'] })` — one variable font (wght 100–900) cut into latin, latin-ext and
 * vietnamese subsets. Licence: SIL Open Font License 1.1, next to the files.
 *
 * Each subset is its own `localFont` call because a call can carry only one
 * `unicode-range`. All three name the same family, `Archivo`, so together they
 * produce the @font-face set Google's stylesheet did: same family, same weights
 * (400 body, 600 labels, 800 headings and button labels — the variable file
 * drawn at each), same ranges, same order. Turkish needs two of them: ç ö ü ı
 * are in latin, ğ ş İ in latin-ext. Both are preloaded; vietnamese is not, as
 * before.
 *
 * next/font accepts only literal arguments, hence the repetition below.
 *
 * Only `archivo` publishes `--font-archivo`; the other two only add faces to
 * the family. The variable names `Archivo Fallback` after it — the
 * size-adjusted Arial that stands in until the file arrives — and that face is
 * written out in globals.css with the overrides next/font/google generated.
 * next/font/local would derive its own from the file (85.41% / 20.43% /
 * 102.80% against 88.96% / 21.28% / 98.70%), and the page would shift
 * differently while the font loads.
 */
export const archivo = localFont({
  src: [
    { path: '../assets/fonts/archivo/archivo-latin.woff2', weight: '400', style: 'normal' },
    { path: '../assets/fonts/archivo/archivo-latin.woff2', weight: '600', style: 'normal' },
    { path: '../assets/fonts/archivo/archivo-latin.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'Archivo' },
    { prop: 'font-stretch', value: '100%' },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  display: 'swap',
  variable: '--font-archivo',
  fallback: ['"Archivo Fallback"'],
  adjustFontFallback: false,
});

export const archivoLatinExt = localFont({
  src: [
    { path: '../assets/fonts/archivo/archivo-latin-ext.woff2', weight: '400', style: 'normal' },
    { path: '../assets/fonts/archivo/archivo-latin-ext.woff2', weight: '600', style: 'normal' },
    { path: '../assets/fonts/archivo/archivo-latin-ext.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'Archivo' },
    { prop: 'font-stretch', value: '100%' },
    {
      prop: 'unicode-range',
      value:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
    },
  ],
  display: 'swap',
  adjustFontFallback: false,
});

export const archivoVietnamese = localFont({
  src: [
    { path: '../assets/fonts/archivo/archivo-vietnamese.woff2', weight: '400', style: 'normal' },
    { path: '../assets/fonts/archivo/archivo-vietnamese.woff2', weight: '600', style: 'normal' },
    { path: '../assets/fonts/archivo/archivo-vietnamese.woff2', weight: '800', style: 'normal' },
  ],
  declarations: [
    { prop: 'font-family', value: 'Archivo' },
    { prop: 'font-stretch', value: '100%' },
    {
      prop: 'unicode-range',
      value:
        'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
    },
  ],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
});
