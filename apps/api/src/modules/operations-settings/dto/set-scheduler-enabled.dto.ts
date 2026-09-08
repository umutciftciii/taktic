import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * The whole payload: one boolean.
 *
 * The job is named in the path rather than in the body, so a request cannot
 * disagree with itself about which switch it means, and the operator is never
 * in the body at all — the controller takes it from the session.
 *
 * The transform accepts the two strings an HTML form sends and nothing else. It
 * deliberately does **not** treat "on", "1" or an empty value as true: this
 * switch starts jobs that move credits and close requests, and a payload the
 * server had to guess at is one it should refuse. `@IsBoolean` turns anything
 * that survives as a string into a 400 with the message below.
 */
export class SetSchedulerEnabledDto {
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'Zamanlanmış iş durumu yalnızca açık veya kapalı olabilir.' })
  enabled!: boolean;
}
