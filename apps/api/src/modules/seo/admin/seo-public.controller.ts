import { Controller, Get, Header, Inject } from '@nestjs/common';
import { SeoRedirectGraphService } from '../seo-redirect-graph.service';

/**
 * SEO-004 — `GET /seo/redirects/active`, the one thing the web middleware
 * reads.
 *
 * Unauthenticated on purpose: every pair in it is observable anyway (request
 * the old address, read the Location header). Only what the web should serve
 * right now is listed — active rows whose target is a live page and whose
 * source is not — and nothing else about a row: no id, no reason, no author.
 * `no-store`: the middleware keeps its own short cache and decides its own
 * staleness; a shared cache in between would only lengthen it.
 */
@Controller('seo')
export class SeoPublicController {
  constructor(@Inject(SeoRedirectGraphService) private readonly graph: SeoRedirectGraphService) {}

  @Get('redirects/active')
  @Header('Cache-Control', 'no-store')
  async activeRedirects() {
    const generatedAt = new Date();
    return { generatedAt, redirects: await this.graph.activeSnapshot(generatedAt) };
  }
}
