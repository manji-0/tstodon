import { IsoInstant, RemotePoll, type RemotePollValue } from "@tstodon/domain";
import type { z } from "zod";
import type { NoteDocumentSchema } from "./activitypub-wire";

/** Mastodon allows a handful of options; this only bounds what a hostile document can store. */
const MAX_OPTIONS = 20;

type NoteDocument = z.infer<typeof NoteDocumentSchema>;

type PollEnd = Exclude<RemotePollValue, { kind: "NoPoll" }>["ends"];

const endOf = (document: NoteDocument): PollEnd => {
  const endTime = IsoInstant.parse(document.endTime ?? "");
  if (endTime.isOk()) {
    return { kind: "At", at: endTime.value };
  }
  // `closed` is the time the poll closed; a bare `true` closed it at an unknown time.
  const closed = IsoInstant.parse(
    typeof document.closed === "string"
      ? document.closed
      : document.closed
        ? document.published
        : "",
  );
  return closed.isOk() ? { kind: "At", at: closed.value } : { kind: "Never" };
};

/**
 * The poll a `Question` carries. `oneOf` is single choice and `anyOf` is
 * multiple choice; a document with neither (or with no usable option) has no poll.
 */
export const remotePollFromDocument = (document: NoteDocument): RemotePollValue => {
  const multiple = document.oneOf === undefined && document.anyOf !== undefined;
  const entries = (multiple ? document.anyOf : document.oneOf) ?? [];
  const options = entries.slice(0, MAX_OPTIONS).map((entry) => ({
    title: entry.name,
    votesCount: entry.replies?.totalItems ?? 0,
  }));
  if (document.type !== "Question" || options.length === 0) {
    return RemotePoll.none;
  }
  const poll = RemotePoll.parse({
    kind: multiple ? "MultipleChoicePoll" : "SingleChoicePoll",
    options,
    ends: endOf(document),
    voters:
      typeof document.votersCount === "number"
        ? { kind: "Reported", count: document.votersCount }
        : { kind: "Unreported" },
  });
  return poll.isOk() ? poll.value : RemotePoll.none;
};
