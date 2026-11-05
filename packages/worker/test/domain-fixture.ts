import { InstanceIdentity, LocalAccount, LocalStatus, RemoteActor } from "@tstodon/domain";
import type { z } from "zod";

const parsed = <T>(result: z.ZodSafeParseResult<T>, what: string): T => {
  if (!result.success) {
    throw new Error(`${what} fixture failed to parse`);
  }
  return result.data;
};

/** The instance `social.example`, for use cases run against in-memory contracts. */
export const testIdentity = (): InstanceIdentity =>
  parsed(
    InstanceIdentity.schema.safeParse({
      kind: "InstanceIdentity",
      domain: "social.example",
      publicOrigin: "https://social.example",
      name: "tstodon",
      description: "test",
      sourceUrl: "https://github.com/example/tstodon",
      languages: ["en"],
      contactEmail: "admin@social.example",
      thumbnailUrl: "https://social.example/thumbnail.png",
      mediaPublicBaseUrl: "https://media.social.example/",
    }),
    "identity",
  );

export const testLocalAccount = (id: string, username: string): LocalAccount =>
  parsed(
    LocalAccount.schema.safeParse({
      kind: "LocalAccount",
      id,
      username,
      accessEmail: `${username}@social.example`,
      displayName: username,
      locked: false,
      defaultPostVisibility: { kind: "Public" },
      defaultQuotePolicy: { kind: "Public" },
      publicKeyPem: "test-public-key",
      privateKeyJwk: "test-private-key",
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
    "local account",
  );

export const testLocalNote = (id: string, inReplyToId: string | null = null): LocalStatus =>
  parsed(
    LocalStatus.schema.safeParse({
      kind: "LocalNote",
      id,
      accountId: "100",
      text: `note ${id}`,
      contentHtml: `<p>note ${id}</p>`,
      visibility: { kind: "Public" },
      spoilerText: "",
      sensitive: false,
      language: { kind: "None" },
      quote: { kind: "None" },
      mediaIds: [],
      poll: { kind: "None" },
      inReplyToId,
      createdAt: "2026-10-01T00:00:00.000Z",
      editedAt: null,
    }),
    "local note",
  );

/** A remote actor value; unlike `remoteActor`, nothing is cached in D1. */
export const testRemoteActor = (username: string, domain = "remote.example"): RemoteActor => {
  const actorUri = `https://${domain}/users/${username}`;
  return parsed(
    RemoteActor.schema.safeParse({
      kind: "RemoteActor",
      actorUri,
      username,
      domain,
      inboxUri: `${actorUri}/inbox`,
      publicKeyId: `${actorUri}#main-key`,
      publicKeyPem: "test-public-key",
      displayName: username,
      profile: RemoteActor.emptyProfile,
      fetchedAt: "2026-10-01T00:00:00.000Z",
    }),
    "remote actor",
  );
};
