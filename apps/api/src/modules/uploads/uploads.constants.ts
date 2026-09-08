import { join } from 'node:path';

// Upload root resolves from the API process cwd. When @taktic/api is started
// via `pnpm --filter @taktic/api dev`, cwd is apps/api, so this points at
// apps/api/uploads regardless of the host OS or docker container layout.
export const UPLOAD_ROOT_DIR = join(process.cwd(), 'uploads');
export const CATEGORY_IMAGE_DIR = join(UPLOAD_ROOT_DIR, 'category-images');
export const CATEGORY_IMAGE_URL_PREFIX = '/uploads/category-images';

export const MAX_CATEGORY_IMAGE_BYTES = 5 * 1024 * 1024;

// Vitrin card images live in their own directory rather than sharing the
// category one. Two reasons, and the second is the load-bearing one: a category
// image is an operator's asset and a card image is a provider's, and putting a
// file anybody with a provider account can upload into the directory the public
// category grid is served from would make one upload route's limits the other's
// exposure.
export const SHOWCASE_IMAGE_DIR = join(UPLOAD_ROOT_DIR, 'showcase-images');
export const SHOWCASE_IMAGE_URL_PREFIX = '/uploads/showcase-images';

// Smaller than a category image on purpose: a card is a tile, not a cover, and
// the ceiling is what an ordinary phone photograph fits under after the browser
// has done nothing to it.
export const MAX_SHOWCASE_IMAGE_BYTES = 3 * 1024 * 1024;

// Image MIME whitelist. SVG is intentionally excluded — admins can inject
// inline <script> in SVG files, and serving them as static assets would
// execute that script in the browser. Re-enable only with a sanitizer.
export const CATEGORY_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const CATEGORY_IMAGE_ALLOWED_MIMES = Object.keys(CATEGORY_IMAGE_MIME_TO_EXT);
