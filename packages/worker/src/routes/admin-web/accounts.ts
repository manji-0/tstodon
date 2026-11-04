import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { approveAccount, setAccountDisabled, setAccountSensitized } from "../../account-flag-store";
import { setAccountModeration } from "../../account-moderation-store";
import type { RemoteActorModerationAction, RemoteActorModerationValue } from "@tstodon/domain";
import { listAdminAccounts } from "../../account-admin-store";
import {
  type AdminAccountState,
  type AdminRemoteActorState,
  adminAccountStates,
  findAdminAccount,
  findAdminRemoteActor,
  moderateRemoteActor,
  purgeAccount,
} from "../../admin-actions";
import {
  accountPage,
  type AccountsQuery,
  accountsPage,
  confirmPage,
  remoteActorPage,
} from "../../admin-pages";
import type { RepositoryError } from "../../d1";
import { RemoteAccountId } from "../../remote-account-id";
import { findRemoteActorAcct, listOpenReportIdsForTarget } from "../../report-store";
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
  const open = await listOpenReportIdsForTarget(c.env.DB, {
    kind: "Local",
    accountId: state.account.id,
  });
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

/** The remote actor's buttons: it can be limited, suspended, and have its media marked sensitive. */
type RemoteAccountCommand = Readonly<{
  label: string;
  /** Whether the actor's state offers this action. */
  offered: (moderation: RemoteActorModerationValue) => boolean;
  /** Asked before the action goes through. */
  confirm?: string;
  action: RemoteActorModerationAction;
}>;

const REMOTE_COMMANDS: Readonly<Record<RemoteActorModerationAction, RemoteAccountCommand>> = {
  silence: {
    label: "Limit",
    offered: (moderation) => moderation.standing.kind === "InGoodStanding",
    action: "silence",
  },
  unsilence: {
    label: "Lift limit",
    offered: (moderation) => moderation.standing.kind === "Silenced",
    action: "unsilence",
  },
  suspend: {
    label: "Suspend",
    offered: (moderation) => moderation.standing.kind !== "Suspended",
    confirm:
      "Suspending hides the account and its posts and refuses everything it sends. You can lift it later.",
    action: "suspend",
  },
  unsuspend: {
    label: "Unsuspend",
    offered: (moderation) => moderation.standing.kind === "Suspended",
    action: "unsuspend",
  },
  sensitize: {
    label: "Mark media as sensitive",
    offered: (moderation) => !moderation.sensitized,
    action: "sensitize",
  },
  unsensitize: {
    label: "Stop marking media as sensitive",
    offered: (moderation) => moderation.sensitized,
    action: "unsensitize",
  },
};

const RemoteCommandSchema = z.union([
  z.literal("silence"),
  z.literal("unsilence"),
  z.literal("suspend"),
  z.literal("unsuspend"),
  z.literal("sensitize"),
  z.literal("unsensitize"),
]);

/** A remote actor at an `r_…` id: what this server has of it, or only its handle once purged. */
type RemoteAccountView = Readonly<{
  actorUri: string;
  acct: string;
  domain: string | undefined;
  state: AdminRemoteActorState | undefined;
}>;

const remoteAccountAt = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<RemoteAccountView, RepositoryError>> => {
  const state = await findAdminRemoteActor(db, actorUri);
  if (state.isErr()) {
    return err(state.error);
  }
  let acct: string;
  if (state.value) {
    acct = `${state.value.actor.username}@${state.value.actor.domain}`;
  } else {
    const remembered = await findRemoteActorAcct(db, actorUri);
    if (remembered.isErr()) {
      return err(remembered.error);
    }
    acct = remembered.value ?? actorUri;
  }
  return ok({
    actorUri,
    acct,
    domain: state.value?.actor.domain ?? remoteDomain(actorUri),
    state: state.value,
  });
};

const renderRemoteAccount = async (
  c: SettingsContext,
  view: RemoteAccountView,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const open = await listOpenReportIdsForTarget(c.env.DB, {
    kind: "Remote",
    actorUri: view.actorUri,
  });
  if (open.isErr()) {
    return serverError(c, open.error);
  }
  const moderation = view.state?.moderation;
  return c.html(
    remoteActorPage(
      instanceName(c.env),
      {
        actorUri: view.actorUri,
        acct: view.acct,
        domain: view.domain,
        moderation,
        openReports: open.value,
        actions:
          moderation === undefined
            ? []
            : Object.entries(REMOTE_COMMANDS)
                .filter(([, command]) => command.offered(moderation))
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
  | Readonly<{ kind: "FoundRemote"; view: RemoteAccountView }>
  | Readonly<{ kind: "Answered"; response: Response }>
> => {
  const remote = RemoteAccountId.decode(id);
  if (remote.isOk()) {
    const view = await remoteAccountAt(c.env.DB, remote.value);
    return view.isOk()
      ? { kind: "FoundRemote", view: view.value }
      : { kind: "Answered", response: serverError(c, view.error) };
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
  switch (found.kind) {
    case "Answered":
      return found.response;
    case "FoundRemote":
      return renderRemoteAccount(c, found.view, noticeOf(c));
    case "Found":
      return renderAccount(c, admin.account.id, found.state, noticeOf(c));
  }
};

/** The remote actor page's moderation buttons; suspending asks again first. */
const postRemoteAccount = async (
  c: SettingsContext,
  view: RemoteAccountView,
  fields: Readonly<Record<string, string>>,
) => {
  const name = schemaResult(RemoteCommandSchema)(fields.do);
  if (name.isErr()) {
    return badForm(c);
  }
  const command = REMOTE_COMMANDS[name.value];
  const path = `/admin/accounts/${RemoteAccountId.encode(view.actorUri)}`;
  if (view.state === undefined || !command.offered(view.state.moderation)) {
    return renderRemoteAccount(
      c,
      view,
      { kind: "error", text: `"${command.label}" does not apply to this account now.` },
      422,
    );
  }
  if (command.confirm !== undefined && fields.confirmed !== "1") {
    return c.html(
      confirmPage(instanceName(c.env), {
        title: `${command.label}: ${view.acct}?`,
        text: command.confirm,
        action: path,
        fields: { do: name.value },
        confirmLabel: command.label,
        cancelHref: path,
      }),
    );
  }
  const ran = await moderateRemoteActor(c.env.DB, view.actorUri, command.action);
  if (ran.isErr()) {
    return serverError(c, ran.error);
  }
  return pageRedirect(c, withNotice(path, "updated"), 303);
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
  if (found.kind === "FoundRemote") {
    return postRemoteAccount(c, found.view, fields);
  }
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

warmSchemas([AccountsQuerySchema, AccountCommandSchema, RemoteCommandSchema]);
