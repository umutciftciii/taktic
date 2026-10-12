import { IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * `POST /admin/service-requests/:id/open-next-round` (REL-002 Faz 5).
 *
 * The round the operator was looking at, the internal note, and the key the
 * form was rendered with: a double submit or a retry with the same key is the
 * same opening.
 */
export class OpenNextRoundDto {
  @IsString()
  @MaxLength(64)
  expectedCurrentRoundId!: string;

  /** Trimmed and whitespace-collapsed by the service, then 10..2000. */
  @IsString()
  @MaxLength(8000)
  note!: string;

  @IsUUID()
  idempotencyKey!: string;
}
