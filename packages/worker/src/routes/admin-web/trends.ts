import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import { reviewTrend, type TrendTarget } from "../../admin-trends";
import { type TrendEntry, type TrendFamily, trendsPage } from "../../admin-content-pages";
import { excerpt } from "../../admin-pages";
import type { RepositoryError } from "../../d1";
import { pageRedirect } from "../../page-redirect";
import { listTrendingStatuses, listTrendingTags } from "../../status-discovery-store";
import { listTrendingLinks } from "../../trend-store";
import { listTrendReviews, type TrendKind } from "../../trend-review-store";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  accountLabeller,
  adminSession,
  badForm,
  notFound,
  noticeOf,
  readFields,
  serverError,
  withNotice,
} from "./shared";

/** Mastodon's `/admin/trends/{tags,links,statuses}` pages: what is trending, and approve or reject it. */

const TRENDS_PER_PAGE = 20;

const REVIEW_KINDS = {
  tags: "Tag",
  links: "Link",
  statuses: "Status",
} as const satisfies Record<TrendFamily, TrendKind>;

const ReviewFormSchema = z.object({
  do: z.union([z.literal("approve"), z.literal("reject")]),
  target: z.string().trim().min(1),
});

const trendEntries = async (
  db: D1Database,
  family: TrendFamily,
): Promise<Result<ReadonlyArray<TrendEntry>, RepositoryError>> => {
  const reviews = await listTrendReviews(db, REVIEW_KINDS[family]);
  if (reviews.isErr()) {
    return reviews.map(() => []);
  }
  switch (family) {
    case "tags": {
      const tags = await listTrendingTags(db, TRENDS_PER_PAGE);
      return tags.map((found) =>
        found.map((tag) => ({
          target: tag.name,
          label: `#${tag.name}`,
          href: undefined,
          detail: `${tag.uses} ${tag.uses === 1 ? "use" : "uses"} this week`,
          review: reviews.value.get(tag.name),
        })),
      );
    }
    case "links": {
      const links = await listTrendingLinks(db, { limit: TRENDS_PER_PAGE });
      return links.map((found) =>
        found.map((link) => ({
          target: link.url,
          label:
            typeof link.document.title === "string" && link.document.title.length > 0
              ? link.document.title
              : link.url,
          href: link.url,
          detail: `${link.uses} ${link.uses === 1 ? "share" : "shares"} this week`,
          review: reviews.value.get(link.url),
        })),
      );
    }
    case "statuses": {
      // The admin list keeps rejected posts so a moderator can approve them again.
      const statuses = await listTrendingStatuses(db, TRENDS_PER_PAGE, { includeRejected: true });
      if (statuses.isErr()) {
        return statuses.map(() => []);
      }
      const label = accountLabeller(db);
      const entries: TrendEntry[] = [];
      for (const status of statuses.value) {
        if (status.kind === "LocalNote") {
          const author = await label(status.accountId);
          entries.push({
            target: status.id,
            label: `${author.label}: ${excerpt(status.text, 100)}`,
            href: author.href === undefined ? undefined : `${author.href}/statuses`,
            detail: status.createdAt,
            review: reviews.value.get(status.id),
          });
        }
      }
      return statuses.map(() => entries);
    }
  }
};

/** Mastodon's `GET /admin/trends` opens the hashtags. */
export const getAdminTrendsIndex = (c: Context<{ Bindings: Env }>) =>
  pageRedirect(c, "/admin/trends/tags");

/** Mastodon's `GET /admin/trends/tags`, `/links`, or `/statuses`. */
export const getAdminTrends = (family: TrendFamily) => async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const entries = await trendEntries(c.env.DB, family);
  return entries.isErr()
    ? serverError(c, entries.error)
    : c.html(trendsPage(instanceName(c.env), { family, entries: entries.value }, noticeOf(c)));
};

const targetOf = (family: TrendFamily, target: string): TrendTarget => {
  switch (family) {
    case "tags":
      return { kind: "Tag", name: target };
    case "links":
      return { kind: "Link", url: target };
    case "statuses":
      return { kind: "Status", id: target };
  }
};

/** Approve (`do=approve`) or reject (`do=reject`) one trend. */
export const postAdminTrends = (family: TrendFamily) => async (c: SettingsContext) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const form = schemaResult(ReviewFormSchema)(await readFields(c));
  if (form.isErr()) {
    return badForm(c);
  }
  const approved = form.value.do === "approve";
  const reviewed = await reviewTrend(
    c.env.DB,
    targetOf(family, form.value.target),
    approved ? "Approved" : "Rejected",
  );
  if (reviewed.isErr()) {
    return reviewed.error.kind === "NotFound"
      ? notFound(c, "trend")
      : serverError(c, reviewed.error);
  }
  return pageRedirect(
    c,
    withNotice(`/admin/trends/${family}`, approved ? "trend_approved" : "trend_rejected"),
    303,
  );
};

warmSchemas([ReviewFormSchema]);
