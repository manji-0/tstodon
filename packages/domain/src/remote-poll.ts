import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { IsoInstant } from "./iso-instant";

const RemotePollOptionSchema = z.object({
  title: z.string(),
  votesCount: z.number().int().nonnegative(),
});

export type RemotePollOption = z.infer<typeof RemotePollOptionSchema>;

const RemotePollEndSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Never") }),
  z.object({ kind: z.literal("At"), at: IsoInstant.schema }),
]);

/** `votersCount` is optional on the wire; a poll that omits it reports no voter total. */
const RemotePollVotersSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Unreported") }),
  z.object({ kind: z.literal("Reported"), count: z.number().int().nonnegative() }),
]);

const pollShape = {
  options: z.array(RemotePollOptionSchema).min(1),
  ends: RemotePollEndSchema,
  voters: RemotePollVotersSchema,
};

/** The poll a remote `Question` carries; `NoPoll` for a plain note. */
export const RemotePollSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NoPoll") }),
  z.object({ kind: z.literal("SingleChoicePoll"), ...pollShape }),
  z.object({ kind: z.literal("MultipleChoicePoll"), ...pollShape }),
]);

export type RemotePoll = z.infer<typeof RemotePollSchema>;

const parseRemotePoll = schemaResult(RemotePollSchema);

const question = (poll: RemotePoll): string =>
  poll.kind === "NoPoll"
    ? ""
    : JSON.stringify([poll.kind, poll.ends, poll.options.map((option) => option.title)]);

export type RemotePollChoiceError = Readonly<{
  kind: "Expired" | "NoChoice" | "TooManyChoices" | "OutOfRange";
}>;

const selectChoices = (
  poll: Exclude<RemotePoll, { kind: "NoPoll" }>,
  requested: ReadonlyArray<number>,
  nowMs: number,
): Result<ReadonlyArray<number>, RemotePollChoiceError> => {
  if (poll.ends.kind === "At" && Date.parse(poll.ends.at) <= nowMs) {
    return err({ kind: "Expired" });
  }
  const choices = [...new Set(requested)];
  if (choices.length === 0) {
    return err({ kind: "NoChoice" });
  }
  if (choices.some((choice) => choice < 0 || choice >= poll.options.length)) {
    return err({ kind: "OutOfRange" });
  }
  if (poll.kind === "SingleChoicePoll" && choices.length > 1) {
    return err({ kind: "TooManyChoices" });
  }
  return ok(choices);
};

export const RemotePoll = {
  schema: RemotePollSchema,
  parse: parseRemotePoll,
  none: { kind: "NoPoll" } as const satisfies RemotePoll,
  /** Whether the question itself is the same; vote counts and the voter total are not part of it. */
  /** The distinct option indexes a vote may cast, or why the poll refuses them. */
  selectChoices,
  sameQuestion: (a: RemotePoll, b: RemotePoll): boolean => question(a) === question(b),
} as const;
