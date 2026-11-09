import { z } from "zod";
import { ApAnnounce, ApCreate } from "./activity";
import { ApContext, ApUri } from "./context";

/**
 * An `OrderedCollection` with its items inline. tstodon serves its
 * collections in one page (the newest items, up to the request's `limit`);
 * it sends no `OrderedCollectionPage`.
 */
const orderedCollection = <Item extends z.ZodType>(item: Item) =>
  z.object({
    "@context": ApContext,
    id: ApUri,
    type: z.literal("OrderedCollection"),
    totalItems: z.number().int().nonnegative(),
    orderedItems: z.array(item),
  });

/** A local account's `followers` / `following`, as actor URIs. */
export const ApActorCollection = orderedCollection(ApUri);
export type ApActorCollectionJSON = z.infer<typeof ApActorCollection>;

/**
 * A local account's outbox: its public and unlisted statuses and boosts, as
 * the `Create` and `Announce` activities that were delivered (each keeps the
 * `@context` it was sent with).
 */
export const ApOutbox = orderedCollection(
  z.discriminatedUnion("type", [
    ApCreate.extend({ "@context": ApContext }),
    ApAnnounce.extend({ "@context": ApContext }),
  ]),
);
export type ApOutboxJSON = z.infer<typeof ApOutbox>;
