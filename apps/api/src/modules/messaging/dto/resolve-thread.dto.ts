import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Opens the conversation for a match, by the request it belongs to.
 *
 * The request id is the only thing a caller supplies. Everything else — which
 * offer won, which provider, which two accounts — is derived on the server from
 * the match itself, so a caller cannot name a thread's participants and cannot
 * point a conversation at somebody who was not part of the match.
 */
export class ResolveThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  requestId!: string;
}
