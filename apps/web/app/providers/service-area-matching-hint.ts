/**
 * B-02 — what a neighbourhood-scoped area reaches, said where the provider
 * chooses one. A request that names no neighbourhood is district-wide and is
 * shown to every neighbourhood provider in that district; nothing wider. The
 * profile forms print it; the vitrin card forms do not, because a card's shelf
 * is matched by its own rule.
 *
 * A plain module rather than an export of `service-area-fields.tsx`: that file
 * is a client module, and a server page importing a constant from it would get
 * a client reference instead of the string.
 */
export const NEIGHBORHOOD_SCOPE_MATCHING_HINT =
  'Tek bir mahalle seçerseniz, o mahalledeki taleplere ek olarak aynı ilçede mahalle belirtilmeden ' +
  'açılan talepler de size gösterilir. Başka ilçelerin talepleri gösterilmez.';
