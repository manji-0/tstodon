import {
  ACTIVITY_STREAMS,
  type ApInstanceActorDocumentJSON,
  SECURITY_V1,
} from "@tstodon/api/activitypub";
import { Sensitive, type SensitiveValue } from "@tstodon/core";
import { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { type RepositoryError, runD1, toRepositoryError } from "./d1";
import type { FetchSigner, FetchSigningKey } from "./federated-fetch";
import {
  findInstanceActorKeyDates as findInstanceActorKeyDatesSql,
  findInstanceActorKeys as findInstanceActorKeysSql,
  insertInstanceActorKeys as insertInstanceActorKeysSql,
  rotateInstanceActorKeys as rotateInstanceActorKeysSql,
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

/**
 * Replace the instance actor's key pair (OPS-8), keeping its key id
 * (`/actor#main-key`): the old private key signs nothing from now on, as
 * every delivery and fetch reads the key when it is signed. Nobody follows
 * the instance actor, so no `Update` goes out: a remote that cached the old
 * key fails to verify the next signature and fetches `/actor` again, as
 * Mastodon does on a failed verification. Resolves to when it was rotated.
 */
export const rotateInstanceActorKeys = async (
  db: D1Database,
): Promise<Result<string, RepositoryError>> => {
  const generated = await generateAccountKeys();
  const rotatedAt = nowIso();
  const stored = await runD1(() =>
    runTyped(
      db,
      rotateInstanceActorKeysSql(
        generated.publicKeyPem,
        generated.privateKeyJwk.reveal(),
        rotatedAt,
      ),
    ),
  );
  return stored.map(() => rotatedAt);
};

const InstanceActorKeyDatesRowSchema = z.object({
  created_at: z.string(),
  rotated_at: z.string().nullable(),
});

/** When the instance actor's key pair was made and last rotated; undefined before its first use. */
export const instanceActorKeyDates = async (
  db: D1Database,
): Promise<
  Result<
    Readonly<{ createdAt: string; rotatedAt: string | undefined }> | undefined,
    RepositoryError
  >
> => {
  const rows = await runD1(() =>
    queryTyped(db, findInstanceActorKeyDatesSql(), InstanceActorKeyDatesRowSchema),
  );
  return rows.map((found) => {
    const row = found[0];
    return row === undefined
      ? undefined
      : { createdAt: row.created_at, rotatedAt: row.rotated_at ?? undefined };
  });
};

export const instanceActorKeyId = (identity: InstanceIdentity): string =>
  `${InstanceIdentity.instanceActorUrl(identity)}#main-key`;

/**
 * Signs ActivityPub GETs as the instance actor (`/actor#main-key`), as
 * Mastodon signs the fetches it makes on the server's behalf, so servers in
 * secure mode answer them. The key is read (or first generated) once, on the
 * first fetch; when D1 cannot give it, fetches go unsigned.
 */
export const instanceActorFetchSigner = (
  db: D1Database,
  identity: InstanceIdentity,
): FetchSigner => {
  let key: Promise<FetchSigningKey | undefined> | undefined;
  return () => {
    key ??= instanceActorKeys(db).then((keys) => {
      if (keys.isErr()) {
        console.error(JSON.stringify({ kind: "FetchNotSigned", message: keys.error.message }));
        return undefined;
      }
      return { keyId: instanceActorKeyId(identity), privateKeyJwk: keys.value.privateKeyJwk };
    });
    return key;
  };
};

/** The instance actor's document, as Mastodon's `InstanceActorSerializer` renders it. */
export const instanceActorDocument = (
  identity: InstanceIdentity,
  publicKeyPem: string,
): ApInstanceActorDocumentJSON => {
  const id = InstanceIdentity.instanceActorUrl(identity);
  return {
    "@context": [
      ACTIVITY_STREAMS,
      SECURITY_V1,
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
