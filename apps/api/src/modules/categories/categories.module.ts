import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  imports: [AuthModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  // Request creation resolves its category through the same router walk the
  // public endpoint uses, so there is exactly one definition of where a routed
  // request lands.
  exports: [CategoriesService],
})
export class CategoriesModule {}
