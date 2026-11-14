import type { ApiMentionJSON } from "@tstodon/api";
import { InstanceIdentity, type LocalAccount, type RemoteActor } from "@tstodon/domain";
import type { StatusMentions } from "./mention-store";
import { RemoteAccountId } from "./remote-account-id";

/**
 * A status's mentions as Mastodon's `Mention` entities: the local accounts,
 * then the remote actors, each list in its stored order. A local account is
 * its id and bare username; a remote actor is its `RemoteAccountId` and
 * `username@domain`. An account or actor that is not found (deleted, or a
 * remote actor not cached yet) is left out.
 */
export const mentionEntities = (
  identity: InstanceIdentity,
  mentions: StatusMentions,
  accountOf: (id: string) => LocalAccount | undefined,
  actorOf: (actorUri: string) => RemoteActor | undefined,
): ApiMentionJSON[] => [
  ...mentions.accountIds.flatMap((id) => {
    const account = accountOf(id);
    return account
      ? [
          {
            id: account.id,
            username: account.username,
            url: InstanceIdentity.actorUrl(identity, account.username),
            acct: account.username,
          },
        ]
      : [];
  }),
  ...mentions.actorUris.flatMap((actorUri) => {
    const actor = actorOf(actorUri);
    return actor
      ? [
          {
            id: RemoteAccountId.encode(actor.actorUri),
            username: actor.username,
            url: actor.actorUri,
            acct: `${actor.username}@${actor.domain}`,
          },
        ]
      : [];
  }),
];
