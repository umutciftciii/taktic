import { Injectable } from '@nestjs/common';
import { CATEGORY_IMAGE_URL_PREFIX } from './uploads.constants';

@Injectable()
export class UploadsService {
  buildCategoryImageUrl(filename: string): string {
    const base = (process.env.API_PUBLIC_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
    return `${base}${CATEGORY_IMAGE_URL_PREFIX}/${filename}`;
  }
}
