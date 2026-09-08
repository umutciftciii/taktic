import { randomUUID } from 'node:crypto';
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
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import {
  CATEGORY_IMAGE_ALLOWED_MIMES,
  CATEGORY_IMAGE_MIME_TO_EXT,
  MAX_SHOWCASE_IMAGE_BYTES,
  SHOWCASE_IMAGE_DIR,
} from '../uploads/uploads.constants';
import { UploadsService } from '../uploads/uploads.service';

/**
 * The image on a vitrin card.
 *
 * A provider route rather than an admin one — the picture is the business's, and
 * an operator uploading it would be authoring part of the card they are meant to
 * be judging. Guarded exactly as the rest of the provider's showcase surface is,
 * so a provider can only write into their own panel.
 *
 * The MIME allow-list is the *same list* the category upload uses, imported
 * rather than restated. SVG is absent from it deliberately and the reason is
 * recorded there: an SVG can carry inline `<script>`, and these files are served
 * as static assets from the API's own origin.
 *
 * The upload is not the publication. A returned URL is a file on disk; it
 * reaches a customer only if it is put on a version and that version is
 * approved — and in this phase, not even then, because nothing renders a card to
 * a visitor yet.
 */
@Controller('providers/:providerId/showcase/uploads')
@UseGuards(AuthGuard, RolesGuard, ProviderAccessGuard)
@Roles(UserRole.PROVIDER, UserRole.SUPER_ADMIN)
export class ShowcaseUploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Post('card-image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, SHOWCASE_IMAGE_DIR),
        // The stored name is a fresh UUID and the extension is decided from the
        // sniffed MIME type, never from what the client called the file. A
        // client-supplied name is a path traversal and an extension confusion
        // waiting to be served back from this origin.
        filename: (_req, file, cb) => {
          const ext = CATEGORY_IMAGE_MIME_TO_EXT[file.mimetype];
          if (!ext) {
            cb(new BadRequestException('Unsupported image type'), '');
            return;
          }
          cb(null, `${randomUUID()}.${ext}`);
        },
      }),
      limits: { fileSize: MAX_SHOWCASE_IMAGE_BYTES, files: 1 },
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
  uploadCardImage(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('file field is required');
    }

    return {
      url: this.uploads.buildShowcaseImageUrl(file.filename),
      filename: file.filename,
      sizeBytes: file.size,
      mimeType: file.mimetype,
    };
  }
}
