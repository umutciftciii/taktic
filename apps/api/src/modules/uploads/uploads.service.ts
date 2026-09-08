import { Injectable } from '@nestjs/common';
import { CATEGORY_IMAGE_URL_PREFIX, SHOWCASE_IMAGE_URL_PREFIX } from './uploads.constants';

@Injectable()
export class UploadsService {
  buildCategoryImageUrl(filename: string): string {
    return this.buildUploadUrl(CATEGORY_IMAGE_URL_PREFIX, filename);
  }

  buildShowcaseImageUrl(filename: string): string {
    return this.buildUploadUrl(SHOWCASE_IMAGE_URL_PREFIX, filename);
  }

  private buildUploadUrl(prefix: string, filename: string): string {
    const base = (process.env.API_PUBLIC_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
    return `${base}${prefix}/${filename}`;
  }
}
