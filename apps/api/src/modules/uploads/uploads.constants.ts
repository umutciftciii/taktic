import { join } from 'node:path';

// Upload root resolves from the API process cwd. When @taktic/api is started
// via `pnpm --filter @taktic/api dev`, cwd is apps/api, so this points at
// apps/api/uploads regardless of the host OS or docker container layout.
export const UPLOAD_ROOT_DIR = join(process.cwd(), 'uploads');
export const CATEGORY_IMAGE_DIR = join(UPLOAD_ROOT_DIR, 'category-images');
export const CATEGORY_IMAGE_URL_PREFIX = '/uploads/category-images';

export const MAX_CATEGORY_IMAGE_BYTES = 5 * 1024 * 1024;

// Image MIME whitelist. SVG is intentionally excluded — admins can inject
// inline <script> in SVG files, and serving them as static assets would
// execute that script in the browser. Re-enable only with a sanitizer.
export const CATEGORY_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const CATEGORY_IMAGE_ALLOWED_MIMES = Object.keys(CATEGORY_IMAGE_MIME_TO_EXT);
