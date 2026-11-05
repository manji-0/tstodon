import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { AccountStanding } from "./account-standing";

const ShownSchema = z.object({ kind: z.literal("Shown") });
const SuspendedSchema = z.object({ kind: z.literal("Suspended") });
const HiddenSchema = z.object({ kind: z.literal("Hidden") });

/**
 * How the account read paths (search, lookup, `GET /accounts/:id`, the
 * `id[]` batch) treat an account, as Mastodon does. `Shown` renders in full.
 * `Suspended` renders with `suspended: true` and its profile stripped, and
 * search leaves it out. `Hidden` is an account on a domain this instance
 * suspends or keeps off its allow list: no read path names it.
 */
const schema = z.discriminatedUnion("kind", [ShownSchema, SuspendedSchema, HiddenSchema]);

export type AccountPresentation = z.infer<typeof schema>;

const shown: AccountPresentation = { kind: "Shown" };
const suspended: AccountPresentation = { kind: "Suspended" };
const hidden: AccountPresentation = { kind: "Hidden" };

const ofStanding = (standing: AccountStanding): AccountPresentation =>
  standing.kind === "Suspended" ? suspended : shown;

export const AccountPresentation = {
  schema,
  parse: schemaResult(schema),
  /** A local account: only its own standing counts. */
  ofLocal: ofStanding,
  /** A remote actor: its domain's federation first, then its own standing. */
  ofRemote: (
    input: Readonly<{ federates: boolean; domainSuspended: boolean; standing: AccountStanding }>,
  ): AccountPresentation =>
    !input.federates || input.domainSuspended ? hidden : ofStanding(input.standing),
  /** Whether account search may list the account. */
  searchable: (presentation: AccountPresentation): boolean => presentation.kind === "Shown",
} as const;
