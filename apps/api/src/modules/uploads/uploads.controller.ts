import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { diskStorage } from 'multer';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import {
  CATEGORY_IMAGE_ALLOWED_MIMES,
  CATEGORY_IMAGE_DIR,
  CATEGORY_IMAGE_MIME_TO_EXT,
  MAX_CATEGORY_IMAGE_BYTES,
} from './uploads.constants';
import { UploadsService } from './uploads.service';

mkdirSync(CATEGORY_IMAGE_DIR, { recursive: true });

@Controller('admin/uploads')
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploadsService: UploadsService) {}

  @Post('category-image')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, CATEGORY_IMAGE_DIR),
        filename: (_req, file, cb) => {
          const ext = CATEGORY_IMAGE_MIME_TO_EXT[file.mimetype];
          if (!ext) {
            cb(new BadRequestException('Unsupported image type'), '');
            return;
          }
          cb(null, `${randomUUID()}.${ext}`);
        },
      }),
      limits: { fileSize: MAX_CATEGORY_IMAGE_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (!CATEGORY_IMAGE_ALLOWED_MIMES.includes(file.mimetype)) {
          cb(
            new BadRequestException(
              `File type ${file.mimetype} not allowed. Use PNG, JPEG, or WebP.`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadCategoryImage(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('file field is required');
    }

    return {
      url: this.uploadsService.buildCategoryImageUrl(file.filename),
      filename: file.filename,
      sizeBytes: file.size,
      mimeType: file.mimetype,
    };
  }
}
