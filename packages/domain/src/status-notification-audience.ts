import type { StatusLanguage } from "./status-quote-target";
import type { RemoteVisibility } from "./visibility";

/**
 * Where a note sits in its thread, as Mastodon's `FeedInsertWorker#notify?`
 * reads it: a reply whose parent is unknown has no `in_reply_to_account_id`,
 * so it counts as a reply to someone else.
 */
export type NoteThread =
  | Readonly<{ kind: "Root" }>
  | Readonly<{ kind: "SelfReply" }>
  | Readonly<{ kind: "ReplyToOther" }>;

/** What decides who gets a note's `status` notification. */
export type NotifiedNote = Readonly<{
  visibility: RemoteVisibility;
  thread: NoteThread;
  language: StatusLanguage;
  /** The local accounts the note names, mentioned or silently addressed. */
  addressed: ReadonlySet<string>;
}>;

/** A local follower of the note's author who asked to be notified of its posts and does not mute it. */
export type NotifyingFollower = Readonly<{
  accountId: string;
  /** The follow's `languages`; empty keeps every language. */
  languages: ReadonlyArray<string>;
}>;

const reachesHome = (note: NotifiedNote, follower: NotifyingFollower): boolean => {
  switch (note.visibility.kind) {
    case "Public":
    case "Unlisted":
    case "FollowersOnly":
      return true;
    case "Limited":
    case "Direct":
      return note.addressed.has(follower.accountId);
  }
};

const keepsLanguage = (note: NotifiedNote, follower: NotifyingFollower): boolean =>
  note.language.kind === "None" ||
  follower.languages.length === 0 ||
  follower.languages.includes(note.language.value);

export const StatusNotificationAudience = {
  /**
   * The followers a new note sends its `status` notification to, as
   * Mastodon's `FanOutOnWriteService` and `FeedInsertWorker#notify?`: the
   * followers the home fan-out reaches (every one for a public, unlisted or
   * followers-only note, the named ones for a limited or direct note) whose
   * follow keeps the note's language (`FeedManager#filter_from_home`), and
   * none for a reply to someone else. `followers` leaves out the ones who
   * mute the author, whether or not the mute hides notifications, as
   * `filter_from_home` filters a muted author's status; blocks and muted
   * conversations are screened when the notification is delivered.
   */
  recipients: (
    note: NotifiedNote,
    followers: ReadonlyArray<NotifyingFollower>,
  ): ReadonlyArray<string> =>
    note.thread.kind === "ReplyToOther"
      ? []
      : followers
          .filter((follower) => reachesHome(note, follower) && keepsLanguage(note, follower))
          .map((follower) => follower.accountId),
} as const;
