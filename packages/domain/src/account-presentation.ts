import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { AccountStanding } from "./account-standing";

const ShownSchema = z.object({ kind: z.literal("Shown") });
const SuspendedSchema = z.object({ kind: z.literal("Suspended") });
const EmptiedSchema = z.object({ kind: z.literal("Emptied") });
const HiddenSchema = z.object({ kind: z.literal("Hidden") });

/**
 * How the read paths treat an account, as Mastodon does. `Shown` renders in
 * full. `Suspended` renders with `suspended: true` and its profile stripped
 * where another record names it (a follower, a conversation participant, a
 * report target), and is left out of search and of lists of accounts.
 * `Emptied` renders as `Suspended`, and none of its statuses is served: a
 * remote actor an instance domain suspension suspended when it was made, on a
 * host a narrower rule exempts now, as Mastodon's `BlockDomainService` sets
 * `suspended_at` and deletes the account's content (`DeleteAccountService`
 * with `reserve_username`). `Hidden` is an account on a domain this instance
 * suspends or keeps off its allow list: no read path names it.
 */
const schema = z.discriminatedUnion("kind", [
  ShownSchema,
  SuspendedSchema,
  EmptiedSchema,
  HiddenSchema,
]);

export type AccountPresentation = z.infer<typeof schema>;

const shown: AccountPresentation = { kind: "Shown" };
const suspended: AccountPresentation = { kind: "Suspended" };
const emptied: AccountPresentation = { kind: "Emptied" };
const hidden: AccountPresentation = { kind: "Hidden" };

const ofStanding = (standing: AccountStanding): AccountPresentation =>
  standing.kind === "Suspended" ? suspended : shown;

export const AccountPresentation = {
  schema,
  parse: schemaResult(schema),
  /** A local account: only its own standing counts. */
  ofLocal: ofStanding,
  /**
   * A remote actor: its domain's federation first, then a suspension that
   * suspended it when made, then its own standing.
   */
  ofRemote: (
    input: Readonly<{
      federates: boolean;
      domainSuspended: boolean;
      suspendedByDomainBlock: boolean;
      standing: AccountStanding;
    }>,
  ): AccountPresentation => {
    if (!input.federates || input.domainSuspended) {
      return hidden;
    }
    return input.suspendedByDomainBlock ? emptied : ofStanding(input.standing);
  },
  /**
   * The opposite of Mastodon's `unavailable?`: search and lists of accounts
   * include the account, and its own statuses, followers, following, featured
   * tags and endorsements show.
   */
  available: (presentation: AccountPresentation): boolean => presentation.kind === "Shown",
} as const;
