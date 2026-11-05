import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalReblog,
  LocalStatus,
  reblogVisibility,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import { type Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { nowInstant } from "../../clock";
import { findAccountById } from "../../account-store";
import {
  type ActivityObjectRef,
  announceActivity,
  likeActivity,
  localNoteRef,
  undoActivity,
} from "../../activitypub";
import type { RepositoryError } from "../../d1";
import { enqueueLocalActivity } from "../../delivery";
import {
  canViewFoundStatus,
  type FoundStatus,
  findStatusAnywhere,
  findVisibleStatusAnywhere,
  foundStatusTarget,
} from "../../found-status";
import { enqueueHomeFanOut } from "../../home-fan-out";
import { publishToAccount } from "../../stream-publish";
import { reachesRemoteInboxes } from "../../outbox-job";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryCursor,
  queryLimit,
  readOptionalBody,
  requireFunctionalUser,
  requireUser,
  setPaginationLinks,
} from "../../http";
import { newEntityId } from "../../ids";
import { ApiRefusal } from "../api-refusal";
import { mastodonStatus } from "../../local-status-documents";
import { mastodonRemoteStatuses } from "../../remote-status-documents";
import { statusDocumentsByIds } from "../../status-documents";

import { InstanceLimits, warmSchemas } from "@tstodon/core";
import { parseInstanceIdentity } from "../../runtime-config";
import {
  bookmarkStatus,
  favouriteStatus,
  listBookmarkedTargets,
  listFavouritedTargets,
  unbookmarkStatus,
  unfavouriteStatus,
} from "../../status-interaction-store";
import { notifyAccount } from "../../notify";
import {
  countPinnedStatuses,
  isStatusPinned,
  pinStatus,
  unpinStatus,
} from "../../status-pin-store";
import {
  deleteReblogOf,
  findLocalReblog,
  findStatusById,
  insertLocalReblog,
} from "../../status-store";
import {
  muteStatusThread,
  resolveThreadRootStatusIds,
  unmuteStatusThread,
} from "../../status-mute-store";
import { z } from "zod";

/** `POST /api/v1/statuses/:id/reblog` — `visibility` is the only parameter. */
export const ReblogBodySchema = z.object({
  visibility: z.string().optional(),
});

const STATUS_PIN_LIMIT = InstanceLimits.account.maxPinnedStatuses;

const setStatusPinned = async (c: Context<{ Bindings: Env }>, pin: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = found.value;
  if (!existing || existing.kind !== "LocalNote" || existing.accountId !== user.value.id) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (pin) {
    const already = await isStatusPinned(c.env.DB, user.value.id, existing.id);
    if (already.isErr()) {
      return jsonRepositoryError(c, already.error.message);
    }
    if (!already.value) {
      if (existing.visibility.kind === "Direct") {
        return c.json(
          {
            error: "Posts that are only visible to mentioned users cannot be pinned",
            kind: "PinnedDirectUnsupported",
          },
          422,
        );
      }
      const count = await countPinnedStatuses(c.env.DB, user.value.id);
      if (count.isErr()) {
        return jsonRepositoryError(c, count.error.message);
      }
      if (count.value >= STATUS_PIN_LIMIT) {
        return c.json(
          {
            error: "You have already pinned the maximum number of posts",
            kind: "PinnedLimitReached",
          },
          422,
        );
      }
    }
    const pinned = await pinStatus(c.env.DB, user.value.id, existing.id);
    if (pinned.isErr()) {
      return jsonRepositoryError(c, pinned.error.message);
    }
  } else {
    const unpinned = await unpinStatus(c.env.DB, user.value.id, existing.id);
    if (unpinned.isErr()) {
      return jsonRepositoryError(c, unpinned.error.message);
    }
  }
  const latest = await findStatusById(c.env.DB, existing.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

export const postV1StatusesByIdPin = (c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/pin">) =>
  setStatusPinned(c, true);
export const postV1StatusesByIdUnpin = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/unpin">,
) => setStatusPinned(c, false);

const setStatusMuted = async (c: Context<{ Bindings: Env }>, mute: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const existing = found.value;
  if (!existing || existing.kind !== "LocalNote") {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const roots = await resolveThreadRootStatusIds(c.env.DB, [existing]);
  if (roots.isErr()) {
    return jsonRepositoryError(c, roots.error.message);
  }
  const rootId = roots.value.get(existing.id) ?? existing.id;
  if (mute) {
    const muted = await muteStatusThread(c.env.DB, user.value.id, rootId);
    if (muted.isErr()) {
      return jsonRepositoryError(c, muted.error.message);
    }
  } else {
    const unmuted = await unmuteStatusThread(c.env.DB, user.value.id, rootId);
    if (unmuted.isErr()) {
      return jsonRepositoryError(c, unmuted.error.message);
    }
  }
  const latest = await findStatusById(c.env.DB, existing.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

export const postV1StatusesByIdMute = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/mute">,
) => setStatusMuted(c, true);
export const postV1StatusesByIdUnmute = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/unmute">,
) => setStatusMuted(c, false);

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** The status as the viewer sees it after an interaction, local or remote alike. */
const targetDocument = async (
  env: Env,
  identity: InstanceIdentity,
  found: FoundStatus,
  viewerId: string,
): Promise<Record<string, unknown> | undefined> =>
  found.kind === "LocalStatus"
    ? mastodonStatus(env, identity, found.status, viewerId)
    : (await mastodonRemoteStatuses(env, identity, [found.status], viewerId))[0];

/** How ActivityPub names a status, or nothing when its local author is gone. */
const activityObjectRef = async (
  db: D1Database,
  identity: InstanceIdentity,
  found: FoundStatus,
): Promise<Result<ActivityObjectRef | undefined, RepositoryError>> => {
  if (found.kind === "RemoteStatus") {
    return ok({ uri: found.status.objectUri, authorUri: found.status.actorUri });
  }
  const author = await findAccountById(db, found.status.accountId);
  return author.map((account) => account && localNoteRef(identity, account, found.status.id));
};

/**
 * Deliver a local account's activity about a cached remote status to the
 * remote side. Best effort, as Mastodon's: the interaction is stored either way.
 */
const federateRemoteInteraction = async (
  env: Env,
  accountId: string,
  kind: "Like" | "Undo",
  activity: Record<string, unknown>,
): Promise<void> => {
  const enqueued = await enqueueLocalActivity(env, accountId, kind, activity);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "InteractionNotFederated", activity: kind }));
  }
};

/**
 * The status an interaction names, as the viewer may see it. With `visible`
 * off (the undo actions), a status the viewer can no longer see still resolves,
 * so an old favourite or bookmark can be withdrawn.
 */
const interactionTarget = async (
  c: Context<{ Bindings: Env }>,
  viewerId: string,
  visible: boolean,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  const id = c.req.param("id") ?? "";
  return visible
    ? findVisibleStatusAnywhere(c.env.DB, id, viewerId)
    : findStatusAnywhere(c.env.DB, id);
};

export const postV1StatusesByIdFavourite = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/favourite">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const found = await interactionTarget(c, user.value.id, true);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const target = found.value;
  const created = await favouriteStatus(c.env.DB, user.value.id, foundStatusTarget(target));
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  if (created.value !== undefined) {
    if (target.kind === "LocalStatus" && target.status.accountId !== user.value.id) {
      await notifyAccount(c.env, {
        accountId: target.status.accountId,
        fromAccountId: user.value.id,
        kind: "favourite",
        statusId: target.status.id,
      });
    }
    if (target.kind === "RemoteStatus") {
      const liked = { uri: target.status.objectUri, authorUri: target.status.actorUri };
      await federateRemoteInteraction(
        c.env,
        user.value.id,
        "Like",
        likeActivity(identity.value, user.value, created.value, liked),
      );
    }
  }
  return c.json(await targetDocument(c.env, identity.value, target, user.value.id));
};

export const postV1StatusesByIdUnfavourite = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/unfavourite">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await interactionTarget(c, user.value.id, false);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const target = found.value;
  const removed = await unfavouriteStatus(c.env.DB, user.value.id, foundStatusTarget(target));
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (removed.value !== undefined && target.kind === "RemoteStatus") {
    const liked = { uri: target.status.objectUri, authorUri: target.status.actorUri };
    await federateRemoteInteraction(
      c.env,
      user.value.id,
      "Undo",
      undoActivity(likeActivity(identity.value, user.value, removed.value, liked)),
    );
  }
  return c.json(await targetDocument(c.env, identity.value, target, user.value.id));
};

/**
 * The status a boost shares: boosting a boost shares the underlying status,
 * as Mastodon does.
 */
const boostedStatus = async (
  db: D1Database,
  found: FoundStatus,
): Promise<Result<FoundStatus | undefined, RepositoryError>> => {
  let target: FoundStatus | undefined = found;
  for (
    let depth = 0;
    target?.kind === "LocalStatus" && target.status.kind === "LocalReblog" && depth < 5;
    depth += 1
  ) {
    const next = await findStatusAnywhere(db, target.status.target.statusId);
    if (next.isErr()) {
      return err(next.error);
    }
    target = next.value;
  }
  return ok(target);
};

/**
 * Mastodon's `StatusPolicy#reblog?`: never a direct status, never someone
 * else's followers-only post, and never one the viewer cannot see.
 */
const rebloggable = async (
  db: D1Database,
  target: FoundStatus,
  viewerId: string,
): Promise<boolean> => {
  if (target.kind === "LocalStatus" && target.status.kind !== "LocalNote") {
    return false;
  }
  const visibility = target.status.visibility.kind;
  const own = target.kind === "LocalStatus" && target.status.accountId === viewerId;
  return (
    visibility !== "Direct" &&
    (visibility !== "FollowersOnly" || own) &&
    (await canViewFoundStatus(db, target, viewerId))
  );
};

/**
 * Store a new boost and tell everyone who hears of it: the boosted local
 * author, followers through the `Announce`, and the booster's own streams and
 * home timelines. Answers the boost as the booster sees it.
 */
const publishBoost = async (
  env: Env,
  identity: InstanceIdentity,
  booster: LocalAccount,
  target: FoundStatus,
  reblog: LocalReblog,
): Promise<Result<Record<string, unknown> | undefined, ApiRefusal>> => {
  const objectRef = await activityObjectRef(env.DB, identity, target);
  if (objectRef.isErr()) {
    return err(ApiRefusal.repository(objectRef.error.message));
  }
  if (!objectRef.value) {
    return err(ApiRefusal.notFound);
  }
  const inserted = await insertLocalReblog(env.DB, reblog);
  if (inserted.isErr()) {
    return err(ApiRefusal.repository(inserted.error.message));
  }
  if (target.kind === "LocalStatus" && target.status.accountId !== booster.id) {
    await notifyAccount(env, {
      accountId: target.status.accountId,
      fromAccountId: booster.id,
      kind: "reblog",
      statusId: target.status.id,
    });
  }
  const enqueued = await enqueueLocalActivity(
    env,
    booster.id,
    "Announce",
    announceActivity(identity, booster, reblog, objectRef.value),
  );
  if (enqueued.isErr()) {
    return err(
      ApiRefusal.repository(
        enqueued.error.kind === "RepositoryError"
          ? enqueued.error.message
          : enqueued.error.kind === "QueueSendFailed"
            ? enqueued.error.message
            : "invalid activity id",
      ),
    );
  }
  const document = await mastodonStatus(env, identity, reblog, booster.id);
  if (document) {
    await publishToAccount(env, booster.id, { kind: "update", payload: document });
  }
  await enqueueHomeFanOut(env, {
    event: "update",
    entryId: reblog.id,
    author: { kind: "LocalAccount", accountId: booster.id },
  });
  return ok(document);
};

export const postV1StatusesByIdReblog = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/reblog">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const body = await readOptionalBody(c, ReblogBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const found = await findStatusAnywhere(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const boosted = found.value ? await boostedStatus(c.env.DB, found.value) : ok(undefined);
  if (boosted.isErr()) {
    return jsonRepositoryError(c, boosted.error.message);
  }
  const target = boosted.value;
  if (!target || !(await rebloggable(c.env.DB, target, user.value.id))) {
    return notFound(c);
  }
  const boostTarget = foundStatusTarget(target);
  const existing = await findLocalReblog(c.env.DB, user.value.id, boostTarget);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (existing.value) {
    // Mastodon answers the boost it already has rather than stacking another.
    const document = await findStatusById(c.env.DB, existing.value);
    if (document.isErr() || !document.value) {
      return notFound(c);
    }
    return c.json(await mastodonStatus(c.env, identity.value, document.value, user.value.id));
  }
  const requested = body.value.visibility;
  let requestedVisibility: Visibility | undefined;
  if (requested !== undefined && requested.length > 0) {
    const parsed = Visibility.fromMastodon(requested);
    // A boost may not be direct (Mastodon excludes it for reblogs).
    if (parsed.isErr() || parsed.value.kind === "Direct") {
      return c.json({ error: "Invalid visibility", kind: "Unknown" }, 400);
    }
    requestedVisibility = parsed.value;
  }
  const reblogId = StatusId.parse(newEntityId());
  if (reblogId.isErr()) {
    return jsonRepositoryError(c, "invalid status id");
  }
  const reblog = LocalStatus.reblog(
    reblogId.value,
    user.value.id,
    boostTarget,
    nowInstant(),
    reblogVisibility(
      target.status.visibility,
      requestedVisibility,
      user.value.defaultPostVisibility,
    ),
  );
  const published = await publishBoost(c.env, identity.value, user.value, target, reblog);
  return published.isErr() ? ApiRefusal.respond(c, published.error) : c.json(published.value);
};

export const postV1StatusesByIdUnreblog = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/unreblog">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await findStatusAnywhere(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const target = foundStatusTarget(found.value);
  const reblogId = await findLocalReblog(c.env.DB, user.value.id, target);
  if (reblogId.isErr()) {
    return jsonRepositoryError(c, reblogId.error.message);
  }
  if (reblogId.value) {
    // The Undo carries the Announce it withdraws, so build it while the boost exists.
    const [reblog, objectRef] = await Promise.all([
      findStatusById(c.env.DB, reblogId.value),
      activityObjectRef(c.env.DB, identity.value, found.value),
    ]);
    await deleteReblogOf(c.env.DB, user.value.id, target);
    await publishToAccount(c.env, user.value.id, { kind: "delete", statusId: reblogId.value });
    await enqueueHomeFanOut(c.env, {
      event: "delete",
      entryId: reblogId.value,
      author: { kind: "LocalAccount", accountId: user.value.id },
    });
    const undo =
      reblog.isOk() && reblog.value?.kind === "LocalReblog" && objectRef.isOk() && objectRef.value
        ? undoActivity(announceActivity(identity.value, user.value, reblog.value, objectRef.value))
        : undefined;
    if (undo && reachesRemoteInboxes(undo, identity.value.domain)) {
      const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Undo", undo);
      if (enqueued.isErr()) {
        console.error(
          JSON.stringify({ kind: "UnreblogNotFederated", statusId: found.value.status.id }),
        );
      }
    }
  }
  return c.json(await targetDocument(c.env, identity.value, found.value, user.value.id));
};

const setBookmarked = async (c: Context<{ Bindings: Env }>, bookmark: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const found = await interactionTarget(c, user.value.id, bookmark);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const target = foundStatusTarget(found.value);
  const saved = bookmark
    ? await bookmarkStatus(c.env.DB, user.value.id, target)
    : await unbookmarkStatus(c.env.DB, user.value.id, target);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  return c.json(await targetDocument(c.env, identity.value, found.value, user.value.id));
};

export const postV1StatusesByIdBookmark = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/bookmark">,
) => setBookmarked(c, true);

export const postV1StatusesByIdUnbookmark = (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/unbookmark">,
) => setBookmarked(c, false);

/** The viewer's favourites or bookmarks, local and remote statuses alike, newest status first. */
const engagedStatuses = async (
  c: Context<{ Bindings: Env }>,
  list: typeof listFavouritedTargets,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryLimit(c.req.query("limit"));
  const targets = await list(c.env.DB, user.value.id, limit, queryCursor(c));
  if (targets.isErr()) {
    return jsonRepositoryError(c, targets.error.message);
  }
  const ids = targets.value.map((target) => target.statusId);
  setPaginationLinks(c, ids, limit);
  const documents = await statusDocumentsByIds(c.env, identity.value, ids, user.value.id);
  return c.json(ids.flatMap((id) => documents.get(id) ?? []));
};

export const getV1Favourites = (c: Context<{ Bindings: Env }, "/api/v1/favourites">) =>
  engagedStatuses(c, listFavouritedTargets);

export const getV1Bookmarks = (c: Context<{ Bindings: Env }, "/api/v1/bookmarks">) =>
  engagedStatuses(c, listBookmarkedTargets);

/**
 * Translation has no backend in this deployment, so an eligible status answers
 * 503 the same way Mastodon does when the translation request fails. Statuses
 * that Mastodon would not translate (private mentions and followers-only posts)
 * are refused with 403 before that.
 */

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ReblogBodySchema]);
