import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MESSAGE_BODY_MAX_LENGTH } from '../messaging.config';

export class SendMessageDto {
  /**
   * The message.
   *
   * The bounds here are a first pass, not the rule: the service trims, strips
   * control characters and re-checks the length, because a body that is only
   * whitespace passes `MinLength(1)` and is still not a message.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(MESSAGE_BODY_MAX_LENGTH * 2)
  body!: string;

  /**
   * The client's idempotency key.
   *
   * Optional. Supplying one means a resubmitted form returns the message it
   * already created instead of a second copy; omitting it means no protection.
   * It is opaque to the server and is never shown to anybody.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientToken?: string;
}
