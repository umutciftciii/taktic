import { Controller, Get, Header, Inject } from '@nestjs/common';
import { SitemapService } from './sitemap.service';

/**
 * `GET /sitemap/entries`, and nothing else under `/sitemap`.
 *
 * Unauthenticated and unguarded on purpose: every id it names has a public
 * page, it varies by nothing about the caller (no session is read, so an
 * operator gets the same body as a visitor), and it takes no parameter — no
 * filter, no page, no view can be asked for. Read-only: there is no handler
 * for any other method, so Nest answers them 404.
 *
 * `no-store` because the body is the list of what is public *now* and a card
 * an operator pulls has to be gone from the next sitemap, not from the one
 * after a cache expires; the sitemap itself is fetched rarely.
 */
@Controller('sitemap')
export class SitemapController {
  constructor(@Inject(SitemapService) private readonly sitemap: SitemapService) {}

  @Get('entries')
  @Header('Cache-Control', 'no-store')
  listEntries() {
    return this.sitemap.listEntries();
  }
}
