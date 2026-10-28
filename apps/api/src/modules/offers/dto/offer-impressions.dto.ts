import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import { OFFER_IMPRESSIONS_MAX } from '../offer-view';

/**
 * OFFER-VIEW-001: the offers a customer's list or comparison screen showed.
 *
 * `surface` says which screen measured it. Validated, logged nowhere and not
 * stored — there is no column for it (K-4 was deferred) — but a client that
 * cannot name the screen it reports from is not one this endpoint trusts.
 */
export class OfferImpressionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OFFER_IMPRESSIONS_MAX)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  offerIds!: string[];

  @IsIn(['LIST', 'COMPARE'])
  surface!: 'LIST' | 'COMPARE';
}
