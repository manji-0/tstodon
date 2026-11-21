/** An account a status can answer, or be written by: local, or a remote actor. */
export type ReplyAccount =
  | Readonly<{ kind: "LocalAccount"; accountId: string }>
  | Readonly<{ kind: "RemoteActor"; actorUri: string }>;

export const ReplyAccount = {
  equals: (a: ReplyAccount, b: ReplyAccount): boolean => {
    switch (a.kind) {
      case "LocalAccount":
        return b.kind === "LocalAccount" && a.accountId === b.accountId;
      case "RemoteActor":
        return b.kind === "RemoteActor" && a.actorUri === b.actorUri;
    }
  },
} as const;

/**
 * Who a status answers, Mastodon's `in_reply_to_account_id`. It is set when
 * the reply is linked to its parent and not computed again: a reply to its
 * author's own reply takes that reply's, any other reply its parent's author
 * (`carried_over_reply_to_account_id`). A reply has `NoAccount` when its
 * parent was not held when it was linked, or carried none over.
 */
export type ReplyLink =
  | Readonly<{ kind: "NotReply" }>
  | Readonly<{ kind: "NoAccount" }>
  | Readonly<{ kind: "Answers"; account: ReplyAccount }>;

export const ReplyLink = {
  /**
   * The link a status row stores: whether it is a reply, and the local
   * account id or remote actor URI it answers (at most one is set).
   */
  fromColumns: (isReply: boolean, accountId: string | null, actorUri: string | null): ReplyLink => {
    if (!isReply) {
      return { kind: "NotReply" };
    }
    if (accountId !== null) {
      return { kind: "Answers", account: { kind: "LocalAccount", accountId } };
    }
    if (actorUri !== null) {
      return { kind: "Answers", account: { kind: "RemoteActor", actorUri } };
    }
    return { kind: "NoAccount" };
  },

  /** Mastodon's `in_reply_to_account_id == account_id`. */
  answersAuthor: (link: ReplyLink, author: ReplyAccount): boolean =>
    link.kind === "Answers" && ReplyAccount.equals(link.account, author),
} as const;
