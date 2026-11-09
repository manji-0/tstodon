import { z } from "zod";

/** The ActivityStreams namespace, the first entry of every `@context` tstodon sends. */
export const ACTIVITY_STREAMS = "https://www.w3.org/ns/activitystreams";

/** The public collection, as `to` / `cc` and the quote policies name it. */
export const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

/** The security vocabulary actors add for `publicKey`. */
export const SECURITY_V1 = "https://w3id.org/security/v1";

/** A URI as tstodon sends it: an `id`, an actor, a collection, an object it names. */
export const ApUri = z.url();

/** A JSON-LD term definition: an IRI or compact IRI, or an expanded definition. */
export const ApTermDefinition = z.union([
  z.string(),
  z.object({
    "@id": z.string(),
    "@type": z.string().optional(),
    "@container": z.string().optional(),
  }),
]);

/**
 * A document's `@context`: ActivityStreams alone, or ActivityStreams first
 * with further vocabularies (`SECURITY_V1`) and term definitions (Mastodon's
 * `toot:`, FEP-044f, GoToSocial's interaction policy, ...).
 */
export const ApContext = z.union([
  z.literal(ACTIVITY_STREAMS),
  z.tuple(
    [z.literal(ACTIVITY_STREAMS)],
    z.union([z.string(), z.record(z.string(), ApTermDefinition)]),
  ),
]);
export type ApContextJSON = z.infer<typeof ApContext>;

/** `schema` with the `@context` a top-level document carries. */
export const withContext = <Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) =>
  schema.extend({ "@context": ApContext });
