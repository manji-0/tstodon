import { InstanceLimits, characterCount } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { AccountId } from "./account-id";
import { IsoInstant } from "./iso-instant";
import { MediaId } from "./media-id";
import type { StatusDraftError } from "./status-draft-error";
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
  validate: (composing: ComposingStatus): Result<ValidatedStatusDraft, StatusDraftError> => {
    const parsedMedia: Array<z.infer<typeof MediaId.schema>> = [];
    for (const value of composing.mediaIds) {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const parsed = MediaId.parse(trimmed);
      if (parsed.isErr()) {
        return err({ kind: "EmptyPayload" });
      }
      parsedMedia.push(parsed.value);
    }

    const text = composing.text.trim();
    const spoilerText = composing.spoilerText.trim();
    const hasText = text.length > 0;
    const hasPoll = composing.poll.kind === "Present";
    if (!hasText && parsedMedia.length === 0 && !hasPoll) {
      return err({ kind: "EmptyPayload" });
    }
    if (characterCount(text) > InstanceLimits.status.maxCharacters) {
      return err({ kind: "TooLong", field: "text", limit: InstanceLimits.status.maxCharacters });
    }
    if (characterCount(spoilerText) > InstanceLimits.status.maxSpoilerCharacters) {
      return err({
        kind: "TooLong",
        field: "spoiler_text",
        limit: InstanceLimits.status.maxSpoilerCharacters,
      });
    }
    if (parsedMedia.length > InstanceLimits.status.maxMediaAttachments) {
      return err({ kind: "TooManyMedia", count: parsedMedia.length });
    }
    if (hasPoll && parsedMedia.length > 0) {
      return err({ kind: "PollWithMedia" });
    }
    if (composing.quote.kind === "Quoted" && (hasPoll || parsedMedia.length > 0)) {
      return err({ kind: "QuoteWithMediaOrPoll" });
    }

    return ok({
      kind: "Validated",
      text,
      visibility: composing.visibility,
      spoilerText,
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
  accountId: AccountId.schema,
  text: ValidatedStatusDraftSchema.shape.text,
  contentHtml: z.string(),
  visibility: Visibility.schema,
  spoilerText: ValidatedStatusDraftSchema.shape.spoilerText,
  sensitive: ValidatedStatusDraftSchema.shape.sensitive,
  language: StatusLanguageSchema,
  quote: StatusQuoteTargetSchema,
  mediaIds: z.array(MediaId.schema),
  poll: StatusPollPresenceSchema,
  inReplyToId: StatusId.schema.nullable(),
  createdAt: IsoInstant.schema,
  editedAt: IsoInstant.schema.nullable(),
});

export const LocalReblogSchema = z.object({
  kind: z.literal("LocalReblog"),
  id: StatusId.schema,
  accountId: AccountId.schema,
  reblogOfId: StatusId.schema,
  createdAt: IsoInstant.schema,
});

export const LocalStatusSchema = z.discriminatedUnion("kind", [LocalNoteSchema, LocalReblogSchema]);

export type LocalNote = z.infer<typeof LocalNoteSchema>;
export type LocalReblog = z.infer<typeof LocalReblogSchema>;
export type LocalStatus = z.infer<typeof LocalStatusSchema>;

export const LocalStatus = {
  schema: LocalStatusSchema,
  publish: (
    id: StatusId,
    accountId: AccountId,
    draft: ValidatedStatusDraft,
    createdAt: z.infer<typeof IsoInstant.schema>,
    contentHtml: string,
    inReplyToId: StatusId | null = null,
  ): LocalNote => ({
    kind: "LocalNote",
    id,
    accountId,
    text: draft.text,
    contentHtml,
    visibility: draft.visibility,
    spoilerText: draft.spoilerText,
    sensitive: draft.sensitive,
    language: draft.language,
    quote: draft.quote,
    mediaIds: draft.mediaIds,
    poll: draft.poll,
    inReplyToId,
    createdAt,
    editedAt: null,
  }),
  reblog: (
    id: StatusId,
    accountId: AccountId,
    reblogOfId: StatusId,
    createdAt: z.infer<typeof IsoInstant.schema>,
  ): LocalReblog => ({
    kind: "LocalReblog",
    id,
    accountId,
    reblogOfId,
    createdAt,
  }),
  /** Apply an edited draft to a note, keeping id, author, thread, and time. */
  revise: (note: LocalNote, draft: ValidatedStatusDraft, contentHtml: string): LocalNote => ({
    kind: "LocalNote",
    id: note.id,
    accountId: note.accountId,
    text: draft.text,
    contentHtml,
    visibility: draft.visibility,
    spoilerText: draft.spoilerText,
    sensitive: draft.sensitive,
    language: draft.language,
    quote: draft.quote,
    mediaIds: draft.mediaIds,
    poll: note.poll,
    inReplyToId: note.inReplyToId,
    createdAt: note.createdAt,
    editedAt: note.editedAt,
  }),
} as const;
