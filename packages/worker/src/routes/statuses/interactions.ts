import {
  type InstanceIdentity,
  type LocalAccount,
  LocalStatus,
  reblogVisibility,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import { type Context } from "hono";
import { nowInstant } from "../../clock";
import { findAccountById } from "../../account-store";
import { announceActivity, undoAnnounceActivity } from "../../activitypub";
import { enqueueLocalActivity } from "../../delivery";
import { reachesRemoteInboxes } from "../../outbox-job";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryCursor,
  queryLimit,
  readOptionalBody,
  requireUser,
  setPaginationLinks,
} from "../../http";
import { newEntityId } from "../../ids";
import { mastodonStatus, mastodonStatuses } from "../../local-status-documents";

import { InstanceLimits, warmSchemas } from "@tstodon/core";
import { parseInstanceIdentity } from "../../runtime-config";
import {
  bookmarkStatus,
  favouriteStatus,
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
import { listBookmarkedStatuses, listFavouritedStatuses } from "../../status-timeline-store";
import {
  muteStatusThread,
  resolveThreadRootStatusIds,
  unmuteStatusThread,
} from "../../status-mute-store";
import { canViewStatus } from "../../visibility-guard";
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

export const postV1StatusesByIdFavourite = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/favourite">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const created = await favouriteStatus(c.env.DB, user.value.id, status.value.id);
  if (created.isOk() && created.value && status.value.accountId !== user.value.id) {
    await notifyAccount(c.env, {
      accountId: status.value.accountId,
      fromAccountId: user.value.id,
      kind: "favourite",
      statusId: status.value.id,
    });
  }
  const latest = await findStatusById(c.env.DB, status.value.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
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
  await unfavouriteStatus(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

export const postV1StatusesByIdReblog = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/reblog">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readOptionalBody(c, ReblogBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const found = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // Boosting a boost shares the underlying status, as Mastodon does.
  let target = found.value;
  for (let depth = 0; target.kind === "LocalReblog" && depth < 5; depth += 1) {
    const original = await findStatusById(c.env.DB, target.reblogOfId);
    if (original.isErr()) {
      return jsonRepositoryError(c, original.error.message);
    }
    if (!original.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    target = original.value;
  }
  // Mastodon's `StatusPolicy#reblog?`: never a direct status, never someone
  // else's followers-only post, and never one the viewer cannot see.
  const rebloggable =
    target.kind === "LocalNote" &&
    target.visibility.kind !== "Direct" &&
    (target.visibility.kind !== "FollowersOnly" || target.accountId === user.value.id) &&
    (await canViewStatus(c.env.DB, target, user.value.id));
  if (!rebloggable) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const existing = await findLocalReblog(c.env.DB, user.value.id, target.id);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (existing.value) {
    // Mastodon answers the boost it already has rather than stacking another.
    const document = await findStatusById(c.env.DB, existing.value);
    if (document.isErr() || !document.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
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
    target.id,
    nowInstant(),
    reblogVisibility(target.visibility, requestedVisibility, user.value.defaultPostVisibility),
  );
  const inserted = await insertLocalReblog(c.env.DB, reblog);
  if (inserted.isErr()) {
    return jsonRepositoryError(c, inserted.error.message);
  }
  if (target.accountId !== user.value.id) {
    await notifyAccount(c.env, {
      accountId: target.accountId,
      fromAccountId: user.value.id,
      kind: "reblog",
      statusId: target.id,
    });
  }
  const noteAuthor = await findAccountById(c.env.DB, target.accountId);
  if (noteAuthor.isErr()) {
    return jsonRepositoryError(c, noteAuthor.error.message);
  }
  if (!noteAuthor.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const enqueued = await enqueueLocalActivity(
    c.env,
    user.value.id,
    "Announce",
    announceActivity(identity.value, user.value, reblog, noteAuthor.value),
  );
  if (enqueued.isErr()) {
    return jsonRepositoryError(
      c,
      enqueued.error.kind === "RepositoryError"
        ? enqueued.error.message
        : enqueued.error.kind === "QueueSendFailed"
          ? enqueued.error.message
          : "invalid activity id",
    );
  }
  const latest = await findStatusById(c.env.DB, reblog.id);
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

/** The `Undo` of the viewer's boost of `statusId`, or undefined when there is none. */
const undoAnnounceFor = async (
  db: D1Database,
  identity: InstanceIdentity,
  booster: LocalAccount,
  statusId: string,
): Promise<Record<string, unknown> | undefined> => {
  const reblogId = await findLocalReblog(db, booster.id, statusId);
  if (reblogId.isErr() || !reblogId.value) {
    return undefined;
  }
  const [reblog, note] = await Promise.all([
    findStatusById(db, reblogId.value),
    findStatusById(db, statusId),
  ]);
  if (reblog.isErr() || reblog.value?.kind !== "LocalReblog" || note.isErr() || !note.value) {
    return undefined;
  }
  const author = await findAccountById(db, note.value.accountId);
  if (author.isErr() || !author.value) {
    return undefined;
  }
  return undoAnnounceActivity(announceActivity(identity, booster, reblog.value, author.value));
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
  // The Undo carries the Announce it withdraws, so build it while the boost exists.
  const undo = await undoAnnounceFor(c.env.DB, identity.value, user.value, c.req.param("id"));
  await deleteReblogOf(c.env.DB, user.value.id, c.req.param("id"));
  if (undo && reachesRemoteInboxes(undo, identity.value.domain)) {
    const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Undo", undo);
    if (enqueued.isErr()) {
      console.error(JSON.stringify({ kind: "UnreblogNotFederated", statusId: c.req.param("id") }));
    }
  }
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

export const postV1StatusesByIdBookmark = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/bookmark">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await bookmarkStatus(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

export const postV1StatusesByIdUnbookmark = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/unbookmark">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await unbookmarkStatus(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
};

export const getV1Favourites = async (c: Context<{ Bindings: Env }, "/api/v1/favourites">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryLimit(c.req.query("limit"));
  const statuses = await listFavouritedStatuses(c.env.DB, user.value.id, limit, queryCursor(c));
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  setPaginationLinks(
    c,
    statuses.value.map((status) => status.id),
    limit,
  );
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
};

export const getV1Bookmarks = async (c: Context<{ Bindings: Env }, "/api/v1/bookmarks">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryLimit(c.req.query("limit"));
  const statuses = await listBookmarkedStatuses(c.env.DB, user.value.id, limit, queryCursor(c));
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  setPaginationLinks(
    c,
    statuses.value.map((status) => status.id),
    limit,
  );
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, user.value.id));
};

/**
 * Translation has no backend in this deployment, so an eligible status answers
 * 503 the same way Mastodon does when the translation request fails. Statuses
 * that Mastodon would not translate (private mentions and followers-only posts)
 * are refused with 403 before that.
 */

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ReblogBodySchema]);
