import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [AuthModule],
  controllers: [UploadsController],
  providers: [UploadsService],
  // Exported so the showcase module can build a card-image URL with the same
  // helper the admin route uses. The URL prefix and the public base are one
  // decision, and a second copy of it is how two upload routes end up serving
  // from paths that disagree.
  exports: [UploadsService],
})
export class UploadsModule {}
