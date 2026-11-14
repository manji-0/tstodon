import type {
  ActivityValue,
  Hostname,
  InstanceIdentity,
  LocalAccount,
  RemoteActor,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import type { z } from "zod";
import type { ActivityJsonSchema } from "../activitypub-wire";
import type { RepositoryError } from "../d1";
import type { FetchSigner } from "../federated-fetch";
import type { LateStepsInFlight } from "../remote-status-owed";

/** Who signed a verified inbox request: a local account, or a fetched remote actor. */
export type InboxSigner =
  | Readonly<{ kind: "Local"; account: LocalAccount }>
  | Readonly<{ kind: "Remote"; actor: RemoteActor }>;

export type ActivityOf<K extends ActivityValue["kind"]> = Extract<ActivityValue, { kind: K }>;

/** A verified, first-seen inbox activity, before the signer picks its handlers. */
export type InboxReceipt = Readonly<{
  env: Env;
  identity: InstanceIdentity;
  activity: ActivityValue;
  /** The activity as received: `Activity` keeps only ids, handlers read the rest here. */
  received: z.infer<typeof ActivityJsonSchema>;
  /** The request body as parsed JSON, before `received` narrowed a list `object` to its first entry. */
  body: unknown;
  allowHosts: ReadonlySet<string>;
  blockedHosts: ReadonlySet<Hostname>;
  /** Signs the GETs handling the activity makes (the instance actor's key). */
  fetchSigner: FetchSigner;
}>;

export type InboxDelivery<Signer, K extends ActivityValue["kind"]> = Readonly<
  Omit<InboxReceipt, "activity"> & { signer: Signer; activity: ActivityOf<K> }
>;

export type RemoteDelivery<K extends ActivityValue["kind"]> = InboxDelivery<RemoteActor, K>;
export type LocalDelivery<K extends ActivityValue["kind"]> = InboxDelivery<LocalAccount, K>;

/**
 * Why an activity was not applied and its sender should deliver it again: a
 * storage failure (5xx), or late steps of its note that another delivery
 * holds (503 with `Retry-After`).
 */
export type InboxError = RepositoryError | LateStepsInFlight;

/**
 * Applies one activity kind for one kind of signer. An `Err` is a reason
 * for the sender to retry; anything the server declines is `Ok`.
 */
export type InboxHandler<Delivery> = (delivery: Delivery) => Promise<Result<void, InboxError>>;
