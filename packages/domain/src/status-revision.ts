import type { StatusLanguage } from "./status-quote-target";

/** What a `PUT /api/v1/statuses/:id` names of the revision; an absent field is one it leaves out. */
export type StatusRevisionRequest = Readonly<{
  text?: string | undefined;
  spoilerText?: string | undefined;
  sensitive?: boolean | undefined;
  language?: string | undefined;
}>;

/** What the revision keeps of the note it replaces. */
type RevisedNote = Readonly<{
  spoilerText: string;
  language: StatusLanguage;
  /** The note quotes a status. */
  quotes: boolean;
}>;

export type StatusRevisionContent = Readonly<{
  text: string;
  spoilerText: string;
  sensitive: boolean;
  language: StatusLanguage;
}>;

/** What `StatusRevision.changesNote` compares of a note before and after a revision. */
type NoteAttributes = StatusRevisionContent & Readonly<{ mediaIds: ReadonlyArray<string> }>;

const sameLanguage = (left: StatusLanguage, right: StatusLanguage): boolean =>
  left.kind === "None"
    ? right.kind === "None"
    : right.kind === "Present" && left.value === right.value;

const blank = (value: string | undefined): value is undefined => (value ?? "").trim().length === 0;

export const StatusRevision = {
  /**
   * The text, content warning, sensitive flag and language of a revision,
   * as Mastodon's `UpdateStatusService#update_immediate_attributes!`. The
   * request is the whole revision: a text or warning it leaves out is
   * empty, and the note is sensitive when the request says so or brings a
   * warning. The language is the one exception: a request that names none
   * keeps the note's. A revision without text takes the request's warning
   * as its text unless the note quotes a status; Mastodon then drops the
   * warning from the request, so the note's own warning stays.
   */
  content: (note: RevisedNote, request: StatusRevisionRequest): StatusRevisionContent => {
    const language: StatusLanguage = blank(request.language)
      ? note.language
      : { kind: "Present", value: request.language };
    if (blank(request.text) && !note.quotes) {
      return {
        text: request.spoilerText ?? "",
        spoilerText: note.spoilerText,
        sensitive: request.sensitive === true,
        language,
      };
    }
    return {
      text: request.text ?? "",
      spoilerText: request.spoilerText ?? "",
      sensitive: request.sensitive === true || !blank(request.spoilerText),
      language,
    };
  },
  /**
   * Whether a revision changes the note's own attributes, as Mastodon's
   * `@status.changed?` in `UpdateStatusService#significant_changes?`: its
   * text, content warning, sensitive flag, language, or the media it
   * attaches and their order. The poll, the media descriptions and focus
   * and the quote policy are compared by the caller, which holds them.
   */
  changesNote: (before: NoteAttributes, after: NoteAttributes): boolean =>
    before.text !== after.text ||
    before.spoilerText !== after.spoilerText ||
    before.sensitive !== after.sensitive ||
    !sameLanguage(before.language, after.language) ||
    before.mediaIds.length !== after.mediaIds.length ||
    before.mediaIds.some((id, index) => after.mediaIds[index] !== id),
} as const;
