import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import { approveAccount, setAccountDisabled, setAccountSensitized } from "../../account-flag-store";
import { setAccountModeration } from "../../account-moderation-store";
import { listAdminAccounts } from "../../account-admin-store";
import {
  type AdminAccountState,
  adminAccountStates,
  findAdminAccount,
  purgeAccount,
} from "../../admin-actions";
import {
  accountPage,
  type AccountsQuery,
  accountsPage,
  confirmPage,
  remoteAccountPage,
} from "../../admin-pages";
import type { RepositoryError } from "../../d1";
import { RemoteAccountId } from "../../remote-account-id";
import { listOpenReportIdsForTarget } from "../../report-store";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  adminSession,
  badForm,
  notFound,
  noticeOf,
  readFields,
  remoteDomain,
  serverError,
  withNotice,
} from "./shared";
import { pageRedirect } from "../../page-redirect";

/** Mastodon's `/admin/accounts` pages: find local accounts and moderate one. */

const AccountsQuerySchema = z.object({
  status: z
    .union([
      z.literal("active"),
      z.literal("pending"),
      z.literal("silenced"),
      z.literal("suspended"),
      z.literal("disabled"),
      z.literal("sensitized"),
    ])
    .catch("active"),
  username: z.string().trim().catch(""),
  email: z.string().trim().catch(""),
});

const ANY_ACCOUNTS: AccountsQuery = { status: "active", username: "", email: "" };

/** Mastodon's `GET /admin/accounts`: local accounts by status, username, and email. */
export const getAdminAccounts = async (c: Context<{ Bindings: Env }, "/admin/accounts">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const query = schemaResult(AccountsQuerySchema)(c.req.query()).unwrapOr(ANY_ACCOUNTS);
  const accounts = await listAdminAccounts(c.env.DB, {
    origin: "local",
    status: query.status,
    username: query.username || undefined,
    email: query.email || undefined,
    limit: 100,
    offset: 0,
  });
  if (accounts.isErr()) {
    return serverError(c, accounts.error);
  }
  const states = await adminAccountStates(c.env.DB, accounts.value);
  if (states.isErr()) {
    return serverError(c, states.error);
  }
  return c.html(accountsPage(instanceName(c.env), query, states.value, noticeOf(c)));
};

type AccountCommand = Readonly<{
  label: string;
  /** Whether the account's state offers this action. */
  offered: (state: AdminAccountState) => boolean;
  /** Asked before the action goes through. */
  confirm?: string;
  run: (env: Env, accountId: string) => Promise<Result<unknown, RepositoryError>>;
  deletes: boolean;
}>;

const AccountCommandSchema = z.union([
  z.literal("approve"),
  z.literal("reject"),
  z.literal("silence"),
  z.literal("unsilence"),
  z.literal("suspend"),
  z.literal("unsuspend"),
  z.literal("sensitize"),
  z.literal("unsensitize"),
  z.literal("disable"),
  z.literal("enable"),
  z.literal("delete"),
]);

type AccountCommandName = z.infer<typeof AccountCommandSchema>;

/** The account page's buttons, in the order it shows them. */
const ACCOUNT_COMMANDS: Readonly<Record<AccountCommandName, AccountCommand>> = {
  approve: {
    label: "Approve",
    offered: (state) => state.pending,
    run: (env, id) => approveAccount(env.DB, id),
    deletes: false,
  },
  reject: {
    label: "Reject",
    offered: (state) => state.pending,
    confirm: "Rejecting deletes the account. This cannot be undone.",
    run: purgeAccount,
    deletes: true,
  },
  silence: {
    label: "Limit",
    offered: (state) => state.moderation === null,
    run: (env, id) => setAccountModeration(env.DB, id, "Silenced"),
    deletes: false,
  },
  unsilence: {
    label: "Lift limit",
    offered: (state) => state.moderation === "Silenced",
    run: (env, id) => setAccountModeration(env.DB, id, null),
    deletes: false,
  },
  suspend: {
    label: "Suspend",
    offered: (state) => state.moderation !== "Suspended",
    confirm:
      "Suspending hides the account and its posts and blocks its login. You can lift it later.",
    run: (env, id) => setAccountModeration(env.DB, id, "Suspended"),
    deletes: false,
  },
  unsuspend: {
    label: "Unsuspend",
    offered: (state) => state.moderation === "Suspended",
    run: (env, id) => setAccountModeration(env.DB, id, null),
    deletes: false,
  },
  sensitize: {
    label: "Mark media as sensitive",
    offered: (state) => !state.sensitized,
    run: (env, id) => setAccountSensitized(env.DB, id, true),
    deletes: false,
  },
  unsensitize: {
    label: "Stop marking media as sensitive",
    offered: (state) => state.sensitized,
    run: (env, id) => setAccountSensitized(env.DB, id, false),
    deletes: false,
  },
  disable: {
    label: "Disable login",
    offered: (state) => !state.disabled,
    run: (env, id) => setAccountDisabled(env.DB, id, true),
    deletes: false,
  },
  enable: {
    label: "Enable login",
    offered: (state) => state.disabled,
    run: (env, id) => setAccountDisabled(env.DB, id, false),
    deletes: false,
  },
  delete: {
    label: "Delete account",
    offered: () => true,
    confirm: "Deleting removes the account and everything it posted. This cannot be undone.",
    run: purgeAccount,
    deletes: true,
  },
};

const renderAccount = async (
  c: SettingsContext,
  viewerId: string,
  state: AdminAccountState,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const open = await listOpenReportIdsForTarget(c.env.DB, state.account.id);
  if (open.isErr()) {
    return serverError(c, open.error);
  }
  return c.html(
    accountPage(
      instanceName(c.env),
      {
        state,
        isViewer: state.account.id === viewerId,
        openReports: open.value,
        actions: Object.entries(ACCOUNT_COMMANDS)
          .filter(([, command]) => command.offered(state))
          .map(([name, command]) => ({ command: name, label: command.label })),
      },
      message,
    ),
    status,
  );
};

/** The account at the path's id, or the page that answers instead. */
const accountAt = async (
  c: SettingsContext,
  id: string,
): Promise<
  | Readonly<{ kind: "Found"; state: AdminAccountState }>
  | Readonly<{ kind: "Answered"; response: Response }>
> => {
  const remote = RemoteAccountId.decode(id);
  const domain = remote.isOk() ? remoteDomain(remote.value) : undefined;
  if (remote.isOk() && domain !== undefined) {
    return {
      kind: "Answered",
      response: c.html(remoteAccountPage(instanceName(c.env), remote.value, domain)),
    };
  }
  const state = await findAdminAccount(c.env.DB, id);
  if (state.isErr()) {
    return { kind: "Answered", response: serverError(c, state.error) };
  }
  return state.value
    ? { kind: "Found", state: state.value }
    : { kind: "Answered", response: notFound(c, "account") };
};

/** Mastodon's `GET /admin/accounts/:id`. */
export const getAdminAccount = async (c: Context<{ Bindings: Env }, "/admin/accounts/:id">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const found = await accountAt(c, c.req.param("id"));
  return found.kind === "Answered"
    ? found.response
    : renderAccount(c, admin.account.id, found.state, noticeOf(c));
};

/** The account page's moderation buttons; destructive ones ask again first. */
export const postAdminAccount = async (c: Context<{ Bindings: Env }, "/admin/accounts/:id">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const found = await accountAt(c, c.req.param("id"));
  if (found.kind === "Answered") {
    return found.response;
  }
  const fields = await readFields(c);
  const name = schemaResult(AccountCommandSchema)(fields.do);
  if (name.isErr()) {
    return badForm(c);
  }
  const command = ACCOUNT_COMMANDS[name.value];
  const { state } = found;
  const path = `/admin/accounts/${state.account.id}`;
  if (state.account.id === admin.account.id) {
    return renderAccount(
      c,
      admin.account.id,
      state,
      { kind: "error", text: "You cannot moderate your own account." },
      422,
    );
  }
  if (!command.offered(state)) {
    return renderAccount(
      c,
      admin.account.id,
      state,
      { kind: "error", text: `"${command.label}" does not apply to this account now.` },
      422,
    );
  }
  if (command.confirm !== undefined && fields.confirmed !== "1") {
    return c.html(
      confirmPage(instanceName(c.env), {
        title: `${command.label}: @${state.account.username}?`,
        text: command.confirm,
        action: path,
        fields: { do: name.value },
        confirmLabel: command.label,
        cancelHref: path,
      }),
    );
  }
  const ran = await command.run(c.env, state.account.id);
  if (ran.isErr()) {
    return serverError(c, ran.error);
  }
  return pageRedirect(
    c,
    command.deletes ? withNotice("/admin/accounts", "deleted") : withNotice(path, "updated"),
    303,
  );
};

warmSchemas([AccountsQuerySchema, AccountCommandSchema]);
