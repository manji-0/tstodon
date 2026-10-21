import {
  InstanceIdentity,
  LocalStatus,
  reblogVisibility,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { nowInstant } from "../../clock";
import { enqueueLocalActivity } from "../../delivery";
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
import { ReblogBodySchema } from "../../schemas";
import { InstanceLimits } from "@tstodon/core";
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

export const statusInteractionRoutes = new Hono<{ Bindings: Env }>();

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

statusInteractionRoutes.post("/api/v1/statuses/:id/pin", (c) => setStatusPinned(c, true));
statusInteractionRoutes.post("/api/v1/statuses/:id/unpin", (c) => setStatusPinned(c, false));

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

statusInteractionRoutes.post("/api/v1/statuses/:id/mute", (c) => setStatusMuted(c, true));
statusInteractionRoutes.post("/api/v1/statuses/:id/unmute", (c) => setStatusMuted(c, false));

statusInteractionRoutes.post("/api/v1/statuses/:id/favourite", async (c) => {
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
});

statusInteractionRoutes.post("/api/v1/statuses/:id/unfavourite", async (c) => {
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
});

statusInteractionRoutes.post("/api/v1/statuses/:id/reblog", async (c) => {
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
  const actor = InstanceIdentity.actorUrl(identity.value, user.value.username);
  const enqueued = await enqueueLocalActivity(c.env, user.value.id, "Announce", {
    type: "Announce",
    actor,
    object: `${actor}/statuses/${target.id}`,
  });
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
});

statusInteractionRoutes.post("/api/v1/statuses/:id/unreblog", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  await deleteReblogOf(c.env.DB, user.value.id, c.req.param("id"));
  const latest = await findStatusById(c.env.DB, c.req.param("id"));
  if (latest.isErr() || !latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonStatus(c.env, identity.value, latest.value, user.value.id));
});

statusInteractionRoutes.post("/api/v1/statuses/:id/bookmark", async (c) => {
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
});

statusInteractionRoutes.post("/api/v1/statuses/:id/unbookmark", async (c) => {
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
});

statusInteractionRoutes.get("/api/v1/favourites", async (c) => {
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
});

statusInteractionRoutes.get("/api/v1/bookmarks", async (c) => {
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
});

/**
 * Translation has no backend in this deployment, so an eligible status answers
 * 503 the same way Mastodon does when the translation request fails. Statuses
 * that Mastodon would not translate (private mentions and followers-only posts)
 * are refused with 403 before that.
 */
