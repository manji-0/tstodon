/** Sweep area INT-15: a profile's bio, fields, avatar, header, bot and locked flags, pinned posts, and a deleted account. */
import { A, signUp, type E2eUser } from "../lib.js";
import { png } from "./media.js";
import {
  Account,
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  knownGap,
  follow,
  tstodonAdmin,
  mastodonRails,
  mastodonUsers,
  onHome,
  post,
  relationship,
  resolveAccount,
  Search,
  Status,
  Statuses,
  step,
  StepFailure,
} from "./sweep.js";

type Account = ReturnType<typeof Account.parse>;

const update = async (user: E2eUser, set: (form: FormData) => void): Promise<Account> => {
  const form = new FormData();
  set(form);
  return call(user, "/api/v1/accounts/update_credentials", Account, { method: "PATCH", form });
};

/** `viewer`'s copy of `target`'s account, once `accept` takes it; a timeout reports the last copy seen. */
const remoteBecomes = async (
  viewer: E2eUser,
  target: E2eUser,
  label: string,
  accept: (account: Account) => boolean,
  show: (account: Account) => unknown,
): Promise<Account> => {
  const { id } = await resolveAccount(viewer, target);
  let last = "";
  try {
    return await eventually(label, async () => {
      const now = await call(viewer, `/api/v1/accounts/${id}`, Account);
      last = JSON.stringify(show(now));
      return accept(now) ? now : undefined;
    });
  } catch (error) {
    throw new StepFailure(`${error instanceof Error ? error.message : String(error)}; saw ${last}`);
  }
};

const loadsAsImage = async (viewer: E2eUser, url: string, what: string): Promise<void> => {
  const response = await fetch(new URL(url, viewer.origin), { headers: viewer.headers });
  const type = response.headers.get("content-type") ?? "";
  await response.arrayBuffer();
  if (!response.ok || !type.startsWith("image/")) {
    throw new StepFailure(`the ${what} ${url} answers ${response.status} ${type}`);
  }
};

/** Whether `viewer`'s server still knows the account: a search by its handle, without a fetch. */
const known = async (viewer: E2eUser, target: E2eUser): Promise<boolean> => {
  const query = new URLSearchParams({ q: target.acct, type: "accounts" });
  const found = await call(viewer, `/api/v2/search?${query.toString()}`, Search);
  return found.accounts.some((account) => account.uri === target.uri);
};

export const profileScenarios = async ({ stamp }: Cast): Promise<void> => {
  const alice = await signUp(A, "pia");
  const leaver = await signUp(A, "leaver");
  const admin = await signUp(A, "profile_admin");
  // The locked flag and the deletion change an account for good, so Mastodon's
  // side of this area is two users of this run.
  const [mona, gone] = await mastodonUsers([`pim_${stamp}`, `gone_${stamp}`]);
  if (!mona || !gone) {
    throw new StepFailure("no Mastodon users");
  }

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays("a new bio reaches the other server", alice, mona, async (from, to) => {
    await update(from, (form) => form.set("note", `bio of ${from.username} ${stamp}`));
    await remoteBecomes(
      to,
      from,
      "the remote account has the bio",
      (account) => account.note.includes(`bio of ${from.username} ${stamp}`),
      (account) => account.note,
    );
  });

  await bothWays("profile fields reach the other server", alice, mona, async (from, to) => {
    await update(from, (form) => {
      form.set("fields_attributes[0][name]", "Pronouns");
      form.set("fields_attributes[0][value]", `they ${stamp}`);
      form.set("fields_attributes[1][name]", "Site");
      form.set("fields_attributes[1][value]", "https://example.com/");
    });
    await remoteBecomes(
      to,
      from,
      "the remote account has both fields",
      (account) =>
        account.fields.length === 2 &&
        account.fields[0]?.name === "Pronouns" &&
        account.fields[0].value.includes(`they ${stamp}`) &&
        account.fields[1]?.name === "Site" &&
        account.fields[1].value.includes("example.com"),
      (account) => account.fields,
    );
  });

  await bothWays("an avatar and a header reach the other server", alice, mona, async (from, to) => {
    const before = await remoteBecomes(
      to,
      from,
      "the remote account",
      () => true,
      () => "",
    );
    await update(from, (form) => {
      form.set("avatar", png([200, 60, 160], 64, 64), "avatar.png");
      form.set("header", png([60, 160, 200], 96, 32), "header.png");
    });
    const after = await remoteBecomes(
      to,
      from,
      "the remote account has a new avatar and header",
      (account) => account.avatar !== before.avatar && account.header !== before.header,
      (account) => ({ avatar: account.avatar, header: account.header }),
    );
    await loadsAsImage(to, after.avatar, "avatar");
    await loadsAsImage(to, after.header, "header");
  });

  await bothWays("the bot flag reaches the other server", alice, mona, async (from, to) => {
    await update(from, (form) => form.set("bot", "true"));
    await remoteBecomes(
      to,
      from,
      "the remote account is a bot",
      (account) => account.bot,
      (account) => account.bot,
    );
    await update(from, (form) => form.set("bot", "false"));
    await remoteBecomes(
      to,
      from,
      "the remote account is no bot again",
      (account) => !account.bot,
      (account) => account.bot,
    );
  });

  /** `viewer`'s server lists (or, with `listed` false, does not list) `uri` among `author`'s pinned posts. */
  const pinnedBecomes = async (
    viewer: E2eUser,
    author: E2eUser,
    uri: string,
    listed: boolean,
  ): Promise<void> => {
    const { id } = await resolveAccount(viewer, author);
    await eventually(
      `the remote profile ${listed ? "lists" : "no longer lists"} the pinned post`,
      async () => {
        const pinned = await call(viewer, `/api/v1/accounts/${id}/statuses?pinned=true`, Statuses);
        return pinned.some((status) => status.uri === uri) === listed ? true : undefined;
      },
    );
  };
  const pinnedBy = new Map<E2eUser, Status>();

  // tstodon's actor has no `featured` collection, so Mastodon never sees a pin.
  await bothWays(
    "a pinned post shows on the remote profile",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, { status: `pinned ${stamp}` });
      await onHome(to, sent.uri);
      await call(from, `/api/v1/statuses/${sent.id}/pin`, Status, { method: "POST", body: {} });
      pinnedBy.set(from, sent);
      await pinnedBecomes(to, from, sent.uri, true);
    },
    { toMastodon: "INT-15" },
  );

  // tstodon reads a remote `featured` collection when it backfills the
  // profile, and does not handle the `Remove` Mastodon sends for an unpin.
  await bothWays(
    "an unpinned post leaves the remote profile",
    alice,
    mona,
    async (from, to) => {
      const sent = pinnedBy.get(from);
      if (!sent) {
        throw new StepFailure("no pinned post");
      }
      await pinnedBecomes(to, from, sent.uri, true);
      await call(from, `/api/v1/statuses/${sent.id}/unpin`, Status, { method: "POST", body: {} });
      await pinnedBecomes(to, from, sent.uri, false);
    },
    { toMastodon: "INT-15", toTstodon: "INT-15" },
  );

  await bothWays("the locked flag reaches the other server", alice, mona, async (from, to) => {
    await update(from, (form) => form.set("locked", "true"));
    await remoteBecomes(
      to,
      from,
      "the remote account is locked",
      (account) => account.locked,
      (account) => account.locked,
    );
  });

  await step("a deleted account is gone from the other server: Mastodon → tstodon", async () => {
    const goneId = await follow(alice, gone);
    const sent = await post(gone, { status: `last words ${stamp}` });
    const copy = await onHome(alice, sent.uri);
    // What Mastodon runs when a user deletes their account in the settings.
    mastodonRails(`
      account = Account.find_local(${JSON.stringify(gone.username)})
      account.suspend!(origin: :local)
      AccountDeletionWorker.new.perform(account.id)
    `);
    await eventually("the follow is gone", async () =>
      (await relationship(alice, goneId).catch(() => ({ following: false }))).following
        ? undefined
        : true,
    );
    await eventually("the account's post is gone", async () => {
      const response = await fetch(`${alice.origin}/api/v1/statuses/${copy.id}`, {
        headers: alice.headers,
      });
      await response.arrayBuffer();
      return response.status === 404 ? true : undefined;
    });
    await eventually("the account is no longer found", async () =>
      (await known(alice, gone)) ? undefined : true,
    );
  });

  // An admin's deletion of a local account sends no `Delete` of the actor.
  await knownGap(
    "a deleted account is gone from the other server: tstodon → Mastodon",
    "INT-15",
    async () => {
      const leaverId = await follow(mona, leaver);
      const sent = await post(leaver, { status: `last words ${stamp}` });
      const copy = await onHome(mona, sent.uri);
      const operator = await tstodonAdmin(admin);
      await call(operator, `/api/v1/admin/accounts/${leaver.id}`, Anything, { method: "DELETE" });
      await eventually("the follow is gone", async () =>
        (await relationship(mona, leaverId).catch(() => ({ following: false }))).following
          ? undefined
          : true,
      );
      await eventually("the account's post is gone", async () => {
        const response = await fetch(`${mona.origin}/api/v1/statuses/${copy.id}`, {
          headers: mona.headers,
        });
        await response.arrayBuffer();
        return response.status === 404 ? true : undefined;
      });
      await eventually("the account is no longer found", async () =>
        (await known(mona, leaver)) ? undefined : true,
      );
    },
  );
};
