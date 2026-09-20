import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { MediaId } from "./media-id";
import { StatusDraftError } from "./status-draft-error";
import {
  StatusLanguageSchema,
  StatusPollPresenceSchema,
  StatusQuoteTarget,
  StatusQuoteTargetSchema,
  type StatusLanguage,
  type StatusPollPresence,
  type StatusQuoteTarget as StatusQuoteTargetValue,
} from "./status-quote-target";
import { StatusId } from "./status-id";
import { Visibility } from "./visibility";

const ComposingStatusSchema = z.object({
  kind: z.literal("Composing"),
  text: z.string(),
  visibility: Visibility.schema,
  spoilerText: z.string(),
  sensitive: z.boolean(),
  language: StatusLanguageSchema,
  quote: StatusQuoteTargetSchema,
  mediaIds: z.array(z.string()),
  poll: StatusPollPresenceSchema,
});

const ValidatedStatusDraftSchema = z.object({
  kind: z.literal("Validated"),
  text: z.string(),
  visibility: Visibility.schema,
  spoilerText: z.string(),
  sensitive: z.boolean(),
  language: StatusLanguageSchema,
  quote: StatusQuoteTargetSchema,
  mediaIds: z.array(MediaId.schema),
  poll: StatusPollPresenceSchema,
});

export const StatusCompositionSchema = z.discriminatedUnion("kind", [
  ComposingStatusSchema,
  ValidatedStatusDraftSchema,
]);

export type ComposingStatus = z.infer<typeof ComposingStatusSchema>;
export type ValidatedStatusDraft = z.infer<typeof ValidatedStatusDraftSchema>;
export type StatusComposition = z.infer<typeof StatusCompositionSchema>;

const noneLanguage = { kind: "None" } as const satisfies StatusLanguage;
const nonePoll = { kind: "None" } as const satisfies StatusPollPresence;

export const StatusComposition = {
  schema: StatusCompositionSchema,
  composing: (input: {
    text: string;
    visibility: ComposingStatus["visibility"];
    spoilerText?: string;
    sensitive?: boolean;
    language?: StatusLanguage;
    quote?: StatusQuoteTargetValue;
    mediaIds?: ReadonlyArray<string>;
    poll?: StatusPollPresence;
  }): ComposingStatus => ({
    kind: "Composing",
    text: input.text,
    visibility: input.visibility,
    spoilerText: input.spoilerText ?? "",
    sensitive: input.sensitive ?? false,
    language: input.language ?? noneLanguage,
    quote: input.quote ?? StatusQuoteTarget.none,
    mediaIds: [...(input.mediaIds ?? [])],
    poll: input.poll ?? nonePoll,
  }),
  validate: (
    composing: ComposingStatus,
  ): Result<ValidatedStatusDraft, StatusDraftError> => {
    const mediaIds = composing.mediaIds
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const parsedMedia = mediaIds.flatMap((value) => {
      const parsed = MediaId.parse(value);
      return parsed.isOk() ? [parsed.value] : [];
    });
    if (parsedMedia.length !== mediaIds.length) {
      return err({ kind: "EmptyPayload" });
    }

    const hasText = composing.text.trim().length > 0;
    const hasPoll = composing.poll.kind === "Present";
    if (!hasText && parsedMedia.length === 0 && !hasPoll) {
      return err({ kind: "EmptyPayload" });
    }
    if (parsedMedia.length > 4) {
      return err({ kind: "TooManyMedia", count: parsedMedia.length });
    }
    if (hasPoll && parsedMedia.length > 0) {
      return err({ kind: "PollWithMedia" });
    }
    if (
      composing.quote.kind === "Quoted" &&
      (hasPoll || parsedMedia.length > 0)
    ) {
      return err({ kind: "QuoteWithMediaOrPoll" });
    }

    return ok({
      kind: "Validated",
      text: composing.text.trim(),
      visibility: composing.visibility,
      spoilerText: composing.spoilerText.trim(),
      sensitive: composing.sensitive,
      language: composing.language,
      quote: composing.quote,
      mediaIds: parsedMedia,
      poll: composing.poll,
    });
  },
} as const;

export const LocalNoteSchema = z.object({
  kind: z.literal("LocalNote"),
  id: StatusId.schema,
  text: ValidatedStatusDraftSchema.shape.text,
  visibility: Visibility.schema,
  spoilerText: ValidatedStatusDraftSchema.shape.spoilerText,
  sensitive: ValidatedStatusDraftSchema.shape.sensitive,
  language: StatusLanguageSchema,
  quote: StatusQuoteTargetSchema,
  mediaIds: z.array(MediaId.schema),
  poll: StatusPollPresenceSchema,
});

export const LocalReblogSchema = z.object({
  kind: z.literal("LocalReblog"),
  id: StatusId.schema,
  reblogOfId: StatusId.schema,
});

export const LocalStatusSchema = z.discriminatedUnion("kind", [
  LocalNoteSchema,
  LocalReblogSchema,
]);

export type LocalNote = z.infer<typeof LocalNoteSchema>;
export type LocalReblog = z.infer<typeof LocalReblogSchema>;
export type LocalStatus = z.infer<typeof LocalStatusSchema>;

export const LocalStatus = {
  schema: LocalStatusSchema,
  publish: (id: StatusId, draft: ValidatedStatusDraft): LocalNote => ({
    kind: "LocalNote",
    id,
    text: draft.text,
    visibility: draft.visibility,
    spoilerText: draft.spoilerText,
    sensitive: draft.sensitive,
    language: draft.language,
    quote: draft.quote,
    mediaIds: draft.mediaIds,
    poll: draft.poll,
  }),
  reblog: (id: StatusId, reblogOfId: StatusId): LocalReblog => ({
    kind: "LocalReblog",
    id,
    reblogOfId,
  }),
} as const;
