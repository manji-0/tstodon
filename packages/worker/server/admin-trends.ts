import { Hostname, StatusId } from "@tstodon/domain";
import { err, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { findStatusById } from "./status-store";
import { setTrendReview, type TrendState } from "./trend-review-store";

/**
 * A trend a moderator reviews. As in Mastodon a tag is named by its name, a
 * link by its URL (it has no row of its own), and a status by its id.
 */
export type TrendTarget =
  | Readonly<{ kind: "Tag"; name: string }>
  | Readonly<{ kind: "Link"; url: string }>
  | Readonly<{ kind: "Status"; id: string }>
  /** A link publisher, by its host. */
  | Readonly<{ kind: "Publisher"; domain: string }>;

export type ReviewTrendError = Readonly<{ kind: "NotFound" }> | RepositoryError;

const isWebUrl = (url: string): boolean => {
  if (!URL.canParse(url)) {
    return false;
  }
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:";
};

/** Record the moderator's decision on a trend that exists to review. */
export const reviewTrend = async (
  db: D1Database,
  target: TrendTarget,
  state: TrendState,
): Promise<Result<void, ReviewTrendError>> => {
  switch (target.kind) {
    case "Tag": {
      const name = target.name.trim();
      return name.length === 0 ? err({ kind: "NotFound" }) : setTrendReview(db, "Tag", name, state);
    }
    case "Link":
      return isWebUrl(target.url)
        ? setTrendReview(db, "Link", target.url, state)
        : err({ kind: "NotFound" });
    case "Publisher": {
      const domain = Hostname.fromInput(target.domain);
      return domain === undefined || domain.includes("/")
        ? err({ kind: "NotFound" })
        : setTrendReview(db, "Publisher", domain, state);
    }
    case "Status": {
      const id = StatusId.parse(target.id);
      if (id.isErr()) {
        return err({ kind: "NotFound" });
      }
      const found = await findStatusById(db, id.value);
      if (found.isErr()) {
        return err(found.error);
      }
      return found.value
        ? setTrendReview(db, "Status", target.id, state)
        : err({ kind: "NotFound" });
    }
  }
};
