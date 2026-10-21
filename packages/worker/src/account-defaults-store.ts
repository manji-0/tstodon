import { type QuoteApprovalPolicy, type Visibility } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { quotePolicySql, visibilitySql } from "./sql-enums";

/** The posting defaults a new status inherits when it omits them. */
export type ComposeDefaults = Readonly<{
  language: string | null;
  sensitive: boolean;
}>;

export const findComposeDefaults = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ComposeDefaults, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare("SELECT default_language, default_sensitive FROM accounts WHERE id = ? LIMIT 1")
      .bind(accountId)
      .first<{ default_language: string | null; default_sensitive: number }>();
    return {
      language:
        row?.default_language !== null &&
        row?.default_language !== undefined &&
        row.default_language.length > 0
          ? row.default_language
          : null,
      sensitive: (row?.default_sensitive ?? 0) !== 0,
    };
  });

/** Store the account-level defaults Mastodon exposes as `source`. */
export const updateAccountDefaults = async (
  db: D1Database,
  accountId: string,
  input: Readonly<{
    visibility?: Visibility;
    quotePolicy?: QuoteApprovalPolicy;
    language?: string | null;
    sensitive?: boolean;
  }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const assignments: string[] = [];
    const binds: Array<string | null> = [];
    if (input.visibility) {
      assignments.push("default_post_visibility = ?");
      binds.push(visibilitySql(input.visibility));
    }
    if (input.quotePolicy) {
      assignments.push("default_quote_policy = ?");
      binds.push(quotePolicySql(input.quotePolicy));
    }
    if (input.language !== undefined) {
      assignments.push("default_language = ?");
      binds.push(input.language);
    }
    if (assignments.length === 0) {
      return;
    }
    if (input.sensitive !== undefined) {
      assignments.push("default_sensitive = ?");
      binds.push(input.sensitive ? "1" : "0");
    }
    await db
      .prepare(`UPDATE accounts SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...binds, nowIso(), accountId)
      .run();
  });
