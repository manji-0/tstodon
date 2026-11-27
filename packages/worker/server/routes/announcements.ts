import type { ApiAnnouncementJSON } from "@tstodon/api";
import { extractHashtags } from "@tstodon/core/post-text";
import type { InstanceIdentity } from "@tstodon/domain";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import {
  announcementFromRow,
  findAnnouncementRowById,
  listPublishedAnnouncements,
} from "../announcement-admin-store";
import { nowIso } from "../clock";
import {
  addAnnouncementReaction,
  announcementReactionState,
  type AnnouncementReactionState,
  dismissAnnouncement,
  listAnnouncementDismissals,
  removeAnnouncementReaction,
} from "../announcement-store";
import { type CustomEmoji, customEmojiJson, emojisInTexts } from "../emoji";
import { loadCustomEmojis } from "../custom-emoji-store";
import { formatPostText, mentionedAccounts } from "../html";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { type KnownMention, knownMentions } from "../mention-resolve";
import { tagUrl } from "../tag-documents";
import {
  activeAnnouncements,
  type Announcement,
  announcements,
  parseInstanceIdentity,
} from "../runtime-config";

/**
 * `REST::AnnouncementSerializer`. Text renders as Mastodon's `linkify(text)`:
 * its URLs, hashtags and the mentions of accounts in `known` are links, and
 * those accounts and hashtags are the announcement's `mentions` and `tags`.
 * HTML is served as it is, with none.
 */
const announcementDocument = (
  identity: InstanceIdentity,
  announcement: Announcement,
  read: boolean,
  reactions: ReadonlyMap<string, AnnouncementReactionState>,
  emojis: ReadonlyArray<CustomEmoji>,
  known: ReadonlyArray<KnownMention>,
): ApiAnnouncementJSON => {
  const names = [...new Set([...announcement.reactions, ...reactions.keys()])];
  const { body } = announcement;
  const source = body.kind === "Text" ? body.text : body.html;
  const mentions = body.kind === "Text" ? mentionedAccounts(body.text, identity, known) : [];
  return {
    id: announcement.id,
    content: body.kind === "Text" ? formatPostText(body.text, { identity, mentions }) : body.html,
    starts_at: announcement.startsAt,
    ends_at: announcement.endsAt,
    all_day: announcement.allDay,
    // A configured announcement may name no publication time: it has been
    // live since it starts (or was last changed), as far as anyone can tell.
    published_at:
      announcement.publishedAt ??
      announcement.startsAt ??
      announcement.updatedAt ??
      new Date(0).toISOString(),
    updated_at: announcement.updatedAt,
    read,
    mentions: mentions.map(({ id, username, url, acct }) => ({ id, username, url, acct })),
    statuses: [],
    tags:
      body.kind === "Text"
        ? extractHashtags(body.text).map((name) => ({ name, url: tagUrl(identity, name) }))
        : [],
    emojis: emojisInTexts([source], emojis).map(customEmojiJson),
    reactions: names.map((name) => {
      const state = reactions.get(name);
      return { name, count: state?.count ?? 0, me: state?.me ?? false };
    }),
  };
};

/** A reaction is allowed when the announcement declares it or it is a custom emoji. */
const reactionAllowed = (
  announcement: Announcement,
  name: string,
  emojis: ReadonlyArray<CustomEmoji>,
): boolean =>
  announcement.reactions.includes(name) ||
  emojis.some((emoji) => emoji.shortcode.toLowerCase() === name.toLowerCase());

/** An announcement is addressable when it is a live config one or a stored row. */
const findAnnouncement = async (env: Env, id: string): Promise<Announcement | undefined> => {
  const configured = activeAnnouncements(announcements(env)).find(
    (announcement) => announcement.id === id,
  );
  if (configured) {
    return configured;
  }
  const row = await findAnnouncementRowById(env.DB, id);
  return row.isOk() && row.value ? announcementFromRow(row.value) : undefined;
};

/** Runtime-authored announcements first, then the ANNOUNCEMENTS var. */
const publicAnnouncements = async (env: Env): Promise<Result<Announcement[], string>> => {
  const stored = await listPublishedAnnouncements(env.DB, nowIso());
  if (stored.isErr()) {
    return err(stored.error.message);
  }
  return ok([...stored.value.map(announcementFromRow), ...activeAnnouncements(announcements(env))]);
};

export const getV1Announcements = async (
  c: Context<{ Bindings: Env }, "/api/v1/announcements">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const active = await publicAnnouncements(c.env);
  if (active.isErr()) {
    return jsonRepositoryError(c, active.error);
  }
  const dismissed = await listAnnouncementDismissals(c.env.DB, user.value.id);
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  const reactions = await announcementReactionState(c.env.DB, user.value.id);
  if (reactions.isErr()) {
    return jsonRepositoryError(c, reactions.error.message);
  }
  const [emojis, known] = await Promise.all([
    loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl),
    knownMentions(
      c.env.DB,
      identity.value,
      active.value.flatMap(({ body }) => (body.kind === "Text" ? [body.text] : [])),
    ),
  ]);
  const empty = new Map<string, AnnouncementReactionState>();
  return c.json(
    active.value.map((announcement) =>
      announcementDocument(
        identity.value,
        announcement,
        dismissed.value.has(announcement.id),
        reactions.value.get(announcement.id) ?? empty,
        emojis,
        known,
      ),
    ),
  );
};

export const postV1AnnouncementsByIdDismiss = async (
  c: Context<{ Bindings: Env }, "/api/v1/announcements/:id/dismiss">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const announcement = await findAnnouncement(c.env, c.req.param("id") ?? "");
  if (!announcement) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const dismissed = await dismissAnnouncement(c.env.DB, user.value.id, announcement.id);
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  return c.json({});
};

const putAnnouncementReaction = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const announcement = await findAnnouncement(c.env, c.req.param("id") ?? "");
  if (!announcement) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const name = c.req.param("name") ?? "";
  const emojis = await loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl);
  if (!reactionAllowed(announcement, name, emojis)) {
    return c.json({ error: "Reaction not allowed", kind: "ReactionNotAllowed" }, 422);
  }
  const added = await addAnnouncementReaction(c.env.DB, user.value.id, announcement.id, name);
  if (added.isErr()) {
    return jsonRepositoryError(c, added.error.message);
  }
  return c.json({});
};

const deleteAnnouncementReactionRoute = async (
  c: Context<{ Bindings: Env }>,
): Promise<Response> => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const announcement = await findAnnouncement(c.env, c.req.param("id") ?? "");
  if (!announcement) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const removed = await removeAnnouncementReaction(
    c.env.DB,
    user.value.id,
    announcement.id,
    c.req.param("name") ?? "",
  );
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  return c.json({});
};

export const putV1AnnouncementsByIdReactionsByName = (
  c: Context<{ Bindings: Env }, "/api/v1/announcements/:id/reactions/:name">,
) => putAnnouncementReaction(c);
export const deleteV1AnnouncementsByIdReactionsByName = (
  c: Context<{ Bindings: Env }, "/api/v1/announcements/:id/reactions/:name">,
) => deleteAnnouncementReactionRoute(c);
