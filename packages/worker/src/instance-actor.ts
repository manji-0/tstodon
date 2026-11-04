import { Sensitive, type SensitiveValue } from "@tstodon/core";
import { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { type RepositoryError, runD1, toRepositoryError } from "./d1";
import {
  findInstanceActorKeys as findInstanceActorKeysSql,
  insertInstanceActorKeys as insertInstanceActorKeysSql,
} from "./generated/prisma/sql";
import { generateAccountKeys } from "./keys";
import { queryTyped, runTyped } from "./typed-sql";

/**
 * Mastodon's instance actor: an `Application` at `/actor` that signs what the
 * server sends on its own behalf, such as a forwarded report's `Flag`, so the
 * reporting user stays anonymous to the other server.
 */
export type InstanceActorKeys = Readonly<{
  publicKeyPem: string;
  privateKeyJwk: SensitiveValue<string>;
}>;

const InstanceActorKeysRowSchema = z.object({
  public_key_pem: z.string().min(1),
  private_key_jwk: Sensitive.schema(z.string().min(1)),
});

const findKeys = async (
  db: D1Database,
): Promise<Result<InstanceActorKeys | undefined, RepositoryError>> => {
  const rows = await runD1(() =>
    queryTyped(db, findInstanceActorKeysSql(), InstanceActorKeysRowSchema),
  );
  return rows.map((found) => {
    const row = found[0];
    return row === undefined
      ? undefined
      : { publicKeyPem: row.public_key_pem, privateKeyJwk: row.private_key_jwk };
  });
};

/**
 * The instance actor's key pair, generated and stored on first use. Two
 * first uses that race both read back the pair that was stored first.
 */
export const instanceActorKeys = async (
  db: D1Database,
): Promise<Result<InstanceActorKeys, RepositoryError>> => {
  const found = await findKeys(db);
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value !== undefined) {
    return ok(found.value);
  }
  const generated = await generateAccountKeys();
  const stored = await runD1(() =>
    runTyped(
      db,
      insertInstanceActorKeysSql(
        generated.publicKeyPem,
        generated.privateKeyJwk.reveal(),
        nowIso(),
      ),
    ),
  );
  if (stored.isErr()) {
    return err(stored.error);
  }
  const kept = await findKeys(db);
  if (kept.isErr()) {
    return err(kept.error);
  }
  return kept.value === undefined
    ? err(toRepositoryError("instance actor keys missing after insert"))
    : ok(kept.value);
};

export const instanceActorKeyId = (identity: InstanceIdentity): string =>
  `${InstanceIdentity.instanceActorUrl(identity)}#main-key`;

/** The instance actor's document, as Mastodon's `InstanceActorSerializer` renders it. */
export const instanceActorDocument = (
  identity: InstanceIdentity,
  publicKeyPem: string,
): Record<string, unknown> => {
  const id = InstanceIdentity.instanceActorUrl(identity);
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
      { manuallyApprovesFollowers: "as:manuallyApprovesFollowers" },
    ],
    id,
    type: "Application",
    preferredUsername: identity.domain,
    inbox: `${id}/inbox`,
    endpoints: { sharedInbox: InstanceIdentity.sharedInboxUrl(identity) },
    url: `${identity.publicOrigin.replace(/\/$/, "")}/about`,
    manuallyApprovesFollowers: true,
    publicKey: { id: instanceActorKeyId(identity), owner: id, publicKeyPem },
  };
};
