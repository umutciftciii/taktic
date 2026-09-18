import { serializeJsonLd, type JsonLd as JsonLdData } from '../lib/seo-json-ld';

/**
 * One `<script type="application/ld+json">` block.
 *
 * Rendered only where the page may be indexed — the caller decides that from
 * `resolveSeoSite()` and the page's query, exactly as it decides its robots
 * meta — so a closed stack and a filtered variant carry no structured data at
 * all. The body goes through `serializeJsonLd`, which escapes what could end
 * the script early; that is the whole reason `dangerouslySetInnerHTML` is
 * acceptable here and nowhere else in this application.
 */
export function JsonLd({ data }: { data: JsonLdData | null }) {
  if (!data) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
