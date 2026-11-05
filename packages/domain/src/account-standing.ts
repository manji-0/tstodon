import { schemaResult } from "@tstodon/core";
import { z } from "zod";

const InGoodStandingSchema = z.object({ kind: z.literal("InGoodStanding") });
const SilencedSchema = z.object({ kind: z.literal("Silenced") });
const SuspendedSchema = z.object({ kind: z.literal("Suspended") });

/**
 * How visible an admin lets an account be, local or remote: in good standing,
 * limited (`silence`), or suspended. Mastodon keeps `silenced_at` and
 * `suspended_at` apart, but a suspension hides everything a silence would,
 * so one standing holds the stronger of the two.
 */
const schema = z.discriminatedUnion("kind", [
  InGoodStandingSchema,
  SilencedSchema,
  SuspendedSchema,
]);

export type AccountStanding = z.infer<typeof schema>;

type InGoodStanding = z.infer<typeof InGoodStandingSchema>;
type Silenced = z.infer<typeof SilencedSchema>;
type Suspended = z.infer<typeof SuspendedSchema>;

/** The standing transitions an admin can ask for. */
export type AccountStandingAction = "silence" | "unsilence" | "suspend" | "unsuspend";

const inGoodStanding: InGoodStanding = { kind: "InGoodStanding" };

/** A suspension is never downgraded to a silence. */
const silence = (_current: InGoodStanding | Silenced): Silenced => ({ kind: "Silenced" });
const suspend = (_current: AccountStanding): Suspended => ({ kind: "Suspended" });
const lift = (_current: Silenced | Suspended): InGoodStanding => inGoodStanding;

export const AccountStanding = {
  schema,
  parse: schemaResult(schema),
  inGoodStanding,
  /**
   * The standing after an action. Silencing never lifts a suspension, and
   * lifting one standing leaves the other alone (`unsilence` does not undo a
   * suspension).
   */
  apply: (current: AccountStanding, action: AccountStandingAction): AccountStanding => {
    switch (action) {
      case "silence":
        return current.kind === "Suspended" ? current : silence(current);
      case "suspend":
        return suspend(current);
      case "unsilence":
        return current.kind === "Silenced" ? lift(current) : current;
      case "unsuspend":
        return current.kind === "Suspended" ? lift(current) : current;
    }
  },
} as const;
