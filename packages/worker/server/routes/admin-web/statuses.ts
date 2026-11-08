import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import { findAccountById } from "../../account-store";
import { accountStatusesPage } from "../../admin-content-pages";
import { type AccountLabel, confirmPage } from "../../admin-pages";
import {
  type AdminStatusEntry,
  listAdminStatuses,
  moderateStatuses,
  type StatusModeration,
} from "../../admin-status-actions";
import { errorPage } from "../../auth-pages";
import { pageRedirect } from "../../page-redirect";
import { RemoteAccountId } from "../../remote-account-id";
import { findRemoteActorByUri } from "../../remote-actor-store";
import { ReportParty } from "../../report-store";
import { parseInstanceIdentity } from "../../runtime-config";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  accountLabeller,
  adminSession,
  badForm,
  type NoticeKey,
  notFound,
  noticeOf,
  readParts,
  serverError,
  textParts,
  withNotice,
} from "./shared";

/** Mastodon's `/admin/accounts/:id/statuses` page: one account's posts, local or remote. */

const STATUSES_PER_PAGE = 50;

const StatusesFormSchema = z.object({
  do: z.union([z.literal("sensitize"), z.literal("unsensitize"), z.literal("delete")]),
});

const MODERATION_NOTICES = {
  sensitize: "posts_marked_sensitive",
  unsensitize: "posts_marked_not_sensitive",
  delete: "posts_deleted",
} as const satisfies Record<StatusModeration, NoticeKey>;

const DELETE_CONFIRMATION =
  "Deleting removes the selected posts. A post from this server is withdrawn from the servers that have it. This cannot be undone.";

/** The account whose posts the path names: its owner, its page, and the label the page gives it. */
const ownerAt = async (
  c: SettingsContext,
  id: string,
): Promise<
  | Readonly<{ kind: "Owner"; owner: ReportParty; path: string; account: AccountLabel }>
  | Readonly<{ kind: "Answered"; response: Response }>
> => {
  const owner = ReportParty.ofAccountId(id);
  const known =
    owner.kind === "Local"
      ? await findAccountById(c.env.DB, owner.accountId)
      : await findRemoteActorByUri(c.env.DB, owner.actorUri);
  if (known.isErr()) {
    return { kind: "Answered", response: serverError(c, known.error) };
  }
  if (!known.value) {
    return { kind: "Answered", response: notFound(c, "account") };
  }
  const path = `/admin/accounts/${owner.kind === "Local" ? owner.accountId : RemoteAccountId.encode(owner.actorUri)}`;
  return { kind: "Owner", owner, path, account: await accountLabeller(c.env.DB)(id) };
};

const renderStatuses = (
  c: SettingsContext,
  view: Readonly<{
    path: string;
    account: AccountLabel;
    statuses: ReadonlyArray<AdminStatusEntry>;
  }>,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const last = view.statuses.at(-1);
  const olderHref =
    view.statuses.length < STATUSES_PER_PAGE || last === undefined
      ? undefined
      : `${view.path}/statuses?${new URLSearchParams({ max_id: last.id }).toString()}`;
  return c.html(
    accountStatusesPage(
      instanceName(c.env),
      { account: view.account, accountPath: view.path, statuses: view.statuses, olderHref },
      message,
    ),
    status,
  );
};

/** Mastodon's `GET /admin/accounts/:id/statuses`. */
export const getAdminAccountStatuses = async (
  c: Context<{ Bindings: Env }, "/admin/accounts/:id/statuses">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const found = await ownerAt(c, c.req.param("id"));
  if (found.kind === "Answered") {
    return found.response;
  }
  const statuses = await listAdminStatuses(c.env.DB, found.owner, {
    limit: STATUSES_PER_PAGE,
    cursor: { maxId: c.req.query("max_id") },
  });
  return statuses.isErr()
    ? serverError(c, statuses.error)
    : renderStatuses(
        c,
        { path: found.path, account: found.account, statuses: statuses.value },
        noticeOf(c),
      );
};

/** Mark the selected posts sensitive or not, or delete them after a confirmation. */
export const postAdminAccountStatuses = async (
  c: Context<{ Bindings: Env }, "/admin/accounts/:id/statuses">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const found = await ownerAt(c, c.req.param("id"));
  if (found.kind === "Answered") {
    return found.response;
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  const parts = await readParts(c);
  const form = schemaResult(StatusesFormSchema)({ do: textParts(parts, "do")[0] });
  if (form.isErr()) {
    return badForm(c);
  }
  // The confirmation page carries the selection as one comma-separated field.
  const statusIds = [
    ...new Set(
      [...textParts(parts, "status_ids"), ...(textParts(parts, "selected")[0] ?? "").split(",")]
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  const back = async (message: PageMessage) => {
    const statuses = await listAdminStatuses(c.env.DB, found.owner, {
      limit: STATUSES_PER_PAGE,
    });
    return statuses.isErr()
      ? serverError(c, statuses.error)
      : renderStatuses(
          c,
          { path: found.path, account: found.account, statuses: statuses.value },
          message,
          422,
        );
  };
  if (found.owner.kind === "Local" && found.owner.accountId === admin.account.id) {
    return back({ kind: "error", text: "You cannot moderate your own account." });
  }
  if (statusIds.length === 0) {
    return back({ kind: "error", text: "Select at least one post." });
  }
  if (form.value.do === "delete" && textParts(parts, "confirmed")[0] !== "1") {
    return c.html(
      confirmPage(instanceName(c.env), {
        title: `Delete ${statusIds.length} ${statusIds.length === 1 ? "post" : "posts"}?`,
        text: DELETE_CONFIRMATION,
        action: `${found.path}/statuses`,
        fields: { do: "delete", selected: statusIds.join(",") },
        confirmLabel: "Delete",
        cancelHref: `${found.path}/statuses`,
      }),
    );
  }
  const moderated = await moderateStatuses(
    c.env,
    identity.value,
    found.owner,
    statusIds,
    form.value.do,
  );
  return moderated.isErr()
    ? serverError(c, moderated.error)
    : pageRedirect(c, withNotice(`${found.path}/statuses`, MODERATION_NOTICES[form.value.do]), 303);
};

warmSchemas([StatusesFormSchema]);
