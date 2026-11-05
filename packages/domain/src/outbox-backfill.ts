import { RemoteStatus } from "./remote-status";
import { Visibility } from "./visibility";

type Audience = Readonly<{ to: ReadonlyArray<string>; cc: ReadonlyArray<string> }>;

/** An item's `object`: a bare URI, or the object embedded with its own audience. */
export type OutboxBackfillObject =
  | Readonly<{ kind: "Uri"; uri: string }>
  | Readonly<{ kind: "Embedded"; uri: string; audience: Audience }>;

/** One `Create` or `Announce` read from a remote actor's outbox. */
export type OutboxBackfillItem = Readonly<{
  type: "Create" | "Announce";
  id: string;
  actor: string;
  object: OutboxBackfillObject;
  audience: Audience;
}>;

/**
 * What a backfill does with an outbox item. `StoreNote` and `StoreBoost`
 * trust the object as the item gives it; `FetchBoost` announces a note from
 * another host, which is fetched by its URI with the boost path's origin checks.
 */
export type OutboxBackfillDecision =
  | Readonly<{ kind: "Ignore" }>
  | Readonly<{ kind: "StoreNote" }>
  | Readonly<{ kind: "StoreBoost" }>
  | Readonly<{ kind: "FetchBoost" }>;

const authorityOf = (uri: string): string | undefined => {
  try {
    return new URL(uri).host.toLowerCase();
  } catch {
    return undefined;
  }
};

const onActorHost = (uri: string, actorUri: string): boolean =>
  authorityOf(uri) === authorityOf(actorUri);

export const OutboxBackfill = {
  /** Whether `uri` shares the actor's `host[:port]`, as a later page or a pinned note must. */
  onActorHost,
  /**
   * Only the actor's own public or unlisted activities, published from its
   * host, are stored. A `Create` is as visible as its note, as Mastodon reads
   * it, since servers (tstodon among them) may address only the note; it is
   * stored only when the note is on the actor's host too.
   */
  decide: (actorUri: string, item: OutboxBackfillItem): OutboxBackfillDecision => {
    const audience =
      item.type === "Create" && item.object.kind === "Embedded"
        ? item.object.audience
        : item.audience;
    const visibility = RemoteStatus.visibilityFromAudience(audience.to, audience.cc);
    if (
      item.actor !== actorUri ||
      !onActorHost(item.id, actorUri) ||
      Visibility.isRestricted(visibility)
    ) {
      return { kind: "Ignore" };
    }
    const objectOnActorHost = onActorHost(item.object.uri, actorUri);
    if (item.type === "Create") {
      return objectOnActorHost ? { kind: "StoreNote" } : { kind: "Ignore" };
    }
    return objectOnActorHost ? { kind: "StoreBoost" } : { kind: "FetchBoost" };
  },
} as const;
