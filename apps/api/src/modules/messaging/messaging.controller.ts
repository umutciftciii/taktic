import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { ListMessagesDto } from './dto/list-messages.dto';
import { ResolveThreadDto } from './dto/resolve-thread.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagingService } from './messaging.service';

/**
 * Messaging, for the two people a match produced and nobody else.
 *
 * Every route requires a session and is restricted to the two roles that can be
 * a party to a match. A SUPER_ADMIN is deliberately not among them: reading
 * message content is not an administrative power in this version, and adding it
 * silently — by letting the role fall through a guard — is exactly how it would
 * arrive without anyone deciding to. Moderation is separate work with its own
 * disclosure.
 *
 * The role guard is the outer ring only. The real check is the relation chain
 * the service re-derives on every call: a CUSTOMER who is not *this* thread's
 * customer gets the same 404 as somebody who invented the id.
 */
@Controller('messages')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
export class MessagingController {
  constructor(@Inject(MessagingService) private readonly messaging: MessagingService) {}

  /** The caller's own conversations. Never anybody else's, by query. */
  @Get('threads')
  listThreads(@CurrentUser() user: AuthUser) {
    return this.messaging.listThreads(user);
  }

  /** The number behind the sidebar badge. Carries no message content. */
  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.messaging.unreadCount(user);
  }

  /**
   * Opens (or re-opens) the conversation for a match.
   *
   * A POST because the first call may create the thread row. It is idempotent:
   * calling it again returns the same thread, and two simultaneous first calls
   * still produce exactly one.
   */
  @Post('threads/resolve')
  resolveThread(@Body() dto: ResolveThreadDto, @CurrentUser() user: AuthUser) {
    return this.messaging.resolveThreadForRequest(dto.requestId, user);
  }

  @Get('threads/:threadId')
  getThread(@Param('threadId') threadId: string, @CurrentUser() user: AuthUser) {
    return this.messaging.getThread(threadId, user);
  }

  @Get('threads/:threadId/messages')
  listMessages(
    @Param('threadId') threadId: string,
    @Query() query: ListMessagesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messaging.listMessages(threadId, user, query);
  }

  @Post('threads/:threadId/messages')
  sendMessage(
    @Param('threadId') threadId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messaging.sendMessage(threadId, user, {
      body: dto.body,
      clientToken: dto.clientToken ?? null,
    });
  }

  @Post('threads/:threadId/read')
  markRead(@Param('threadId') threadId: string, @CurrentUser() user: AuthUser) {
    return this.messaging.markRead(threadId, user);
  }
}
