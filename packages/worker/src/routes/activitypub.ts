import {
  ActivityId,
  InboxActivity,
  InstanceIdentity,
  type LocalAccount,
  RemoteActor,
} from "@tstodon/domain";
import type { Context } from "hono";
import { findAccountByUsername, findAccountsByIds } from "../account-store";
import { activityPayloadFromJson, noteDocument, parseLocalActorUsername } from "../activitypub";
import { jsonRepositoryError, queryLimit } from "../http";
import { verifyInboxRequest, parseSignatureHeader } from "../http-signature";
import { localActorDocument } from "../local-actor";
import { suspendedDomains } from "../admin-domain-block-store";
import { getRemoteActorModeration } from "../remote-actor-moderation-store";
import { signedFetchActor } from "../signed-fetch";
import { inboxActivityExists, insertInboxActivity } from "../inbox-store";
import { dispatchInbox } from "../inbox/dispatch";
import type { InboxSigner } from "../inbox/handler";
import { listPublicOutboxActivities } from "../outbox-store";
import { resolveRemoteActor } from "../remote-actor-fetch";
import { findRemoteActorByUri, findRemoteFollow } from "../remote-actor-store";
import { RemoteDeleteTarget } from "../remote-delete";
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { quotedStatusUri } from "../quote-uri";
import { ActivityJsonSchema, JsonObjectSchema } from "../activitypub-wire";
import { parseJsonColumn, parseJsonText } from "../json-column";
import { schemaResult } from "@tstodon/core";
import { listFollowers, listFollowing } from "../follow-store";
import { loadNoteMentions } from "../mention-resolve";
import { loadNoteMedia } from "../note-attachments";
import { loadNoteReply } from "../reply-target";
import { loadNotePoll } from "../poll-store";
import { findStatusById } from "../status-store";
import { RemoteAccountId } from "../remote-account-id";
import { instanceActorDocument, instanceActorKeys } from "../instance-actor";

const parseActivityJson = schemaResult(ActivityJsonSchema);

const jsonLd = {
  "content-type": "application/activity+json",
};

export const getUsersByUsername = async (c: Context<{ Bindings: Env }, "/users/:username">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const document = await localActorDocument(c.env.DB, identity.value, account.value);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return c.json(document.value, 200, jsonLd);
};

export const getUsersByUsernameStatusesById = async (
  c: Context<{ Bindings: Env }, "/users/:username/statuses/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (
    !status.value ||
    status.value.kind !== "LocalNote" ||
    status.value.accountId !== account.value.id
  ) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const media = await loadNoteMedia(c.env.DB, identity.value, status.value);
  if (media.isErr()) {
    return jsonRepositoryError(c, media.error.message);
  }
  const note = noteDocument(identity.value, account.value, status.value, {
    quoteUri: await quotedStatusUri(c.env, identity.value, status.value.id),
    mentions: await loadNoteMentions(c.env.DB, identity.value, status.value.id),
    reply: await loadNoteReply(c.env.DB, identity.value, status.value),
    poll: await loadNotePoll(c.env.DB, status.value.id),
    media: media.value,
  });
  const visibility = status.value.visibility.kind;
  if (visibility !== "Public" && visibility !== "Unlisted") {
    // Followers-only and direct notes go to a signed fetch from an actor they
    // address (Mastodon's authorized fetch), and never into a shared cache.
    const signer = await signedFetchActor(c.env, identity.value, c.req.raw);
    if (!signer || !(await noteAddresses(c.env.DB, note, account.value, signer.actorUri))) {
      return c.json({ kind: "NotFound" }, 404);
    }
    c.header("Cache-Control", "private");
    c.header("Vary", "Signature");
  }
  return c.json(note, 200, jsonLd);
};

/**
 * Does the note's audience include this remote actor: named in `to`/`cc`, or an
 * accepted follower when the author's followers collection is addressed?
 */
const noteAddresses = async (
  db: D1Database,
  note: Readonly<Record<string, unknown>>,
  author: LocalAccount,
  actorUri: string,
): Promise<boolean> => {
  const audience = [note.to, note.cc].flatMap((field) =>
    Array.isArray(field) ? field.filter((uri) => typeof uri === "string") : [],
  );
  if (audience.includes(actorUri)) {
    return true;
  }
  if (!audience.includes(`${String(note.attributedTo)}/followers`)) {
    return false;
  }
  const follow = await findRemoteFollow(db, author.id, actorUri);
  return follow.isOk() && follow.value?.requestKind === "Fulfilled";
};

const collection = (id: string, items: ReadonlyArray<string>) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id,
  type: "OrderedCollection",
  totalItems: items.length,
  orderedItems: items,
});

export const getUsersByUsernameOutbox = async (
  c: Context<{ Bindings: Env }, "/users/:username/outbox">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  // What anyone may read, as in Mastodon: public or unlisted notes and boosts.
  // The query filters before its LIMIT, so a page is not cut short.
  const rows = await listPublicOutboxActivities(
    c.env.DB,
    account.value.id,
    queryLimit(c.req.query("limit"), 20),
  );
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  const items = rows.value.flatMap((row) => {
    const payload = parseJsonColumn(JsonObjectSchema, row.payload_json);
    return payload.isOk() ? [payload.value] : [];
  });
  return c.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/outbox`,
      type: "OrderedCollection",
      totalItems: items.length,
      orderedItems: items,
    },
    200,
    jsonLd,
  );
};

export const getUsersByUsernameFollowers = async (
  c: Context<{ Bindings: Env }, "/users/:username/followers">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const ids = await listFollowers(c.env.DB, account.value.id, queryLimit(c.req.query("limit")));
  if (ids.isErr()) {
    return jsonRepositoryError(c, ids.error.message);
  }
  const followers = await findAccountsByIds(
    c.env.DB,
    ids.value.map((edge) => edge.accountId),
  );
  const items = ids.value.flatMap((edge) => {
    const remote = RemoteAccountId.decode(edge.accountId);
    if (remote.isOk()) {
      return [remote.value];
    }
    const follower = followers.isOk() ? followers.value.get(edge.accountId) : undefined;
    return follower ? [InstanceIdentity.actorUrl(identity.value, follower.username)] : [];
  });
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  return c.json(collection(`${actor}/followers`, items), 200, jsonLd);
};

export const getUsersByUsernameFollowing = async (
  c: Context<{ Bindings: Env }, "/users/:username/following">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const ids = await listFollowing(c.env.DB, account.value.id, queryLimit(c.req.query("limit")));
  if (ids.isErr()) {
    return jsonRepositoryError(c, ids.error.message);
  }
  const targets = await findAccountsByIds(
    c.env.DB,
    ids.value.map((edge) => edge.accountId),
  );
  const items = ids.value.flatMap((edge) => {
    const remote = RemoteAccountId.decode(edge.accountId);
    if (remote.isOk()) {
      return [remote.value];
    }
    const target = targets.isOk() ? targets.value.get(edge.accountId) : undefined;
    return target ? [InstanceIdentity.actorUrl(identity.value, target.username)] : [];
  });
  const actor = InstanceIdentity.actorUrl(identity.value, account.value.username);
  return c.json(collection(`${actor}/following`, items), 200, jsonLd);
};

const handleInbox = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const bodyText = await c.req.text();
  const json = parseJsonText(bodyText);
  if (json.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const activityJson = parseActivityJson(json.value);
  if (activityJson.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const signature = parseSignatureHeader(c.req.header("Signature") ?? "");
  if (!signature) {
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  const suspended = await suspendedDomains(c.env.DB);
  const allowHosts = await federationAllowHosts(c.env);
  const payload = activityPayloadFromJson(activityJson.value);
  const actorUri = String(payload.actor);
  const actorUsername = parseLocalActorUsername(identity.value, actorUri);
  const deletesSigner =
    payload.kind === "Delete" &&
    RemoteDeleteTarget.of(actorUri, String(payload.object)).kind === "ActorDelete";
  let signer: InboxSigner;
  if (actorUsername) {
    const actorAccount = await findAccountByUsername(c.env.DB, actorUsername);
    if (actorAccount.isErr()) {
      return jsonRepositoryError(c, actorAccount.error.message);
    }
    if (!actorAccount.value) {
      return c.json({ kind: "InvalidSignature" }, 401);
    }
    signer = { kind: "Local", account: actorAccount.value };
  } else {
    // A repeated account Delete from an actor already purged: there is nothing
    // to remove and its key can no longer be fetched.
    if (deletesSigner) {
      const cached = await findRemoteActorByUri(c.env.DB, actorUri);
      if (cached.isErr()) {
        return jsonRepositoryError(c, cached.error.message);
      }
      if (!cached.value) {
        return c.body(null, 202);
      }
    }
    const remote = await resolveRemoteActor(c.env.DB, identity.value, signature.keyId, actorUri, {
      allowHosts,
      blockedHosts: suspended,
      checkSignature: (publicKeyPem) => verifyInboxRequest(c.req.raw, publicKeyPem, bodyText),
    });
    if (remote.isErr()) {
      if (remote.error.kind === "VerificationUnavailable") {
        c.header("Retry-After", "5");
        return c.json({ kind: "VerificationUnavailable" }, 503);
      }
      if (remote.error.kind === "RepositoryError") {
        return jsonRepositoryError(c, remote.error.message);
      }
      if (remote.error.kind === "DomainRefused") {
        return c.json(
          { error: "This instance does not federate with that domain", kind: "Forbidden" },
          403,
        );
      }
      return c.json({ kind: "InvalidSignature" }, 401);
    }
    // Limited federation: an actor outside the allow list never federates here.
    if (
      RemoteActor.hostnames(remote.value).some(
        (host) => suspended.has(host) || !allowListAdmits(allowHosts, host),
      )
    ) {
      return c.json(
        { error: "This instance does not federate with that domain", kind: "Forbidden" },
        403,
      );
    }
    // An admin suspended this actor: nothing it sends is processed, except
    // the deletion of its own account.
    const moderation = await getRemoteActorModeration(c.env.DB, remote.value.actorUri);
    if (moderation.isErr()) {
      return jsonRepositoryError(c, moderation.error.message);
    }
    if (moderation.value.standing.kind === "Suspended" && !deletesSigner) {
      return c.json({ error: "This actor is suspended on this instance", kind: "Forbidden" }, 403);
    }
    signer = { kind: "Remote", actor: remote.value };
  }
  const publicKeyPem =
    signer.kind === "Local" ? signer.account.publicKeyPem : signer.actor.publicKeyPem;
  const verified = await verifyInboxRequest(c.req.raw, publicKeyPem, bodyText);
  if (!verified) {
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  const activityId = ActivityId.parse(payload.id);
  if (activityId.isErr()) {
    return c.json({ kind: "ValidationError" }, 400);
  }
  const known = await inboxActivityExists(c.env.DB, activityId.value);
  if (known.isErr()) {
    return jsonRepositoryError(c, known.error.message);
  }
  const received = InboxActivity.dispatch(
    { kind: "Received", activityId: activityId.value, payload },
    known.value ? new Set([activityId.value]) : new Set(),
  );
  if (received.kind === "Duplicate") {
    return c.body(null, 202);
  }
  if (received.kind === "Rejected") {
    await insertInboxActivity(c.env.DB, {
      activityId: activityId.value,
      kind: received.error.kind,
      payload: activityJson.value,
    });
    return c.json(received.error, 400);
  }
  await insertInboxActivity(c.env.DB, {
    activityId: activityId.value,
    kind: received.kind === "Dispatched" ? received.activity.kind : "Received",
    payload: activityJson.value,
  });
  if (received.kind !== "Dispatched") {
    return c.body(null, 202);
  }
  const applied = await dispatchInbox(
    {
      env: c.env,
      identity: identity.value,
      activity: received.activity,
      received: activityJson.value,
      body: json.value,
      allowHosts,
      blockedHosts: suspended,
    },
    signer,
  );
  if (applied.isErr()) {
    return jsonRepositoryError(c, applied.error.message);
  }
  return c.body(null, 202);
};

export const postUsersByUsernameInbox = (c: Context<{ Bindings: Env }, "/users/:username/inbox">) =>
  handleInbox(c);
export const postInbox = (c: Context<{ Bindings: Env }, "/inbox">) => handleInbox(c);
export const postActorInbox = (c: Context<{ Bindings: Env }, "/actor/inbox">) => handleInbox(c);

/** Mastodon's instance actor document (`GET /actor`). */
export const getActor = async (c: Context<{ Bindings: Env }, "/actor">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const keys = await instanceActorKeys(c.env.DB);
  if (keys.isErr()) {
    return jsonRepositoryError(c, keys.error.message);
  }
  return c.json(instanceActorDocument(identity.value, keys.value.publicKeyPem), 200, jsonLd);
};
