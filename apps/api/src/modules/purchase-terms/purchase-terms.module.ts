import { Module } from '@nestjs/common';
import { PurchaseTermsService } from './purchase-terms.service';

/**
 * CMP-006 PR-A: the purchase-terms release gate and acceptance writer.
 * No controller of its own — the checkout screen reads the terms through
 * `GET /payments/purchase-terms`, next to `GET /payments/mode`.
 */
@Module({
  providers: [PurchaseTermsService],
  exports: [PurchaseTermsService],
})
export class PurchaseTermsModule {}
