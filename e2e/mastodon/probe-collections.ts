/** Sweep area FED-20: collections (FEP-7aa9) between tstodon and Mastodon v4.7.5. */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Account,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  mastodonRails,
  resolveAccount,
  step,
  StepFailure,
} from "./sweep.js";

const Discoverable = Account.extend({ discoverable: z.boolean().nullish() });

const Item = z.looseObject({
  id: z.string(),
  state: z.string(),
  account_id: z.string().optional(),
});
const Collection = z.looseObject({
  id: z.string(),
  uri: z.string(),
  name: z.string(),
  local: z.boolean(),
  items: z.array(Item),
});
const Wrapped = z.looseObject({ collection: Collection });
const Listed = z.looseObject({ collections: z.array(Collection) });
const Notifications = z.array(
  z.looseObject({ type: z.string(), collection: Collection.nullable().optional() }),
);

/** `owner` makes a collection on its server featuring `featured` (as the owner resolves it). */
const featureIn = async (owner: E2eUser, featured: E2eUser, name: string) => {
  const account = await resolveAccount(owner, featured);
  return (
    await call(owner, "/api/v1/collections", Wrapped, {
      method: "POST",
      body: { name, sensitive: false, discoverable: true, account_ids: [account.id] },
    })
  ).collection;
};

export const collectionScenarios = async ({ stamp, mona }: Cast): Promise<void> => {
  const alice = await signUp(A, "cora");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  // Unless an account is discoverable, Mastodon's `canFeature` lists only the
  // account itself (`ActorSerializer#interaction_policy`), so no one else may
  // feature it. A tstodon account is discoverable from sign up; a provisioned
  // Mastodon one is not.
  await step("the Mastodon account opts in to discovery", async () => {
    const form = new FormData();
    form.set("discoverable", "true");
    await call(mona, "/api/v1/accounts/update_credentials", Discoverable, {
      method: "PATCH",
      form,
    });
    const { id } = await resolveAccount(alice, mona);
    await eventually("tstodon holds the account as discoverable", async () =>
      (await call(alice, `/api/v1/accounts/${id}`, Discoverable)).discoverable === true
        ? true
        : undefined,
    );
  });

  await bothWays(
    "a collection featuring the other server's account is accepted there",
    alice,
    mona,
    async (owner, featured) => {
      const name = `Picks ${stamp} ${owner === alice ? "ts" : "ma"}`;
      const made = await featureIn(owner, featured, name);
      const pending = made.items[0];
      if (pending?.state !== "pending") {
        throw new StepFailure(`the item is ${JSON.stringify(pending)}, not pending`);
      }
      // The featured server answered the FeatureRequest with an Accept. The
      // owner's server sends the collection's Add with it, as Mastodon's
      // CreateCollectionService does, and Mastodon may take them in parallel:
      // the FeatureRequest's fetch of the collection then loses the race to
      // insert it (`index_collections_on_uri`), and Sidekiq retries the job
      // 15 to 25 s later.
      await eventually(
        "the owner sees the item accepted",
        async () => {
          const shown = await call(owner, `/api/v1/collections/${made.id}`, Wrapped);
          return shown.collection.items[0]?.state === "accepted" ? true : undefined;
        },
        60_000,
      );
      // The featured account's server stored the collection (its Add) and its item.
      await eventually("the featured account lists the collection it is in", async () => {
        const self = await resolveAccount(featured, featured);
        const listed = await call(featured, `/api/v1/accounts/${self.id}/in_collections`, Listed);
        return listed.collections.some((collection) => collection.uri === made.uri)
          ? true
          : undefined;
      });
      await eventually("the featured account is told", async () => {
        const notifications = await call(
          featured,
          "/api/v1/notifications?types[]=added_to_collection",
          Notifications,
        );
        return notifications.some((notification) => notification.collection?.name === name)
          ? true
          : undefined;
      });
    },
  );

  await bothWays(
    "a collection is read from the owner's featuredCollections",
    alice,
    mona,
    async (owner, reader) => {
      const name = `Listed ${stamp} ${owner === alice ? "ts" : "ma"}`;
      const made = (
        await call(owner, "/api/v1/collections", Wrapped, {
          method: "POST",
          body: { name, sensitive: false, discoverable: true },
        })
      ).collection;
      const ownerOnReader = await resolveAccount(reader, owner);
      if (reader === mona) {
        // Mastodon has no API to refetch an account: refresh it as its daily job does.
        mastodonRails(`
          account = Account.find_by!(uri: ${JSON.stringify(owner.uri)})
          ActivityPub::FetchFeaturedCollectionsCollectionService.new.call(account)
        `);
      }
      await eventually("the reader lists the owner's collection", async () => {
        const listed = await call(
          reader,
          `/api/v1/accounts/${ownerOnReader.id}/collections`,
          Listed,
        );
        const found = listed.collections.find((collection) => collection.uri === made.uri);
        return found && !found.local && found.name === name ? true : undefined;
      });
    },
  );
};
