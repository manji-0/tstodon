import type {
  RemoteNotificationWithdrawal,
  RemovedRemoteStatus,
  RepositoryError,
} from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { withdrawRemoteStatus } from "./remote-status-delete";

const actorUri = "https://remote.example/users/bob";
const removed: RemovedRemoteStatus = { id: "500", public: true, boosts: [] };

const recording = (deleted: RemovedRemoteStatus | undefined) => {
  const published: RemovedRemoteStatus[] = [];
  const withdrawn: RemoteNotificationWithdrawal[] = [];
  return {
    published,
    withdrawn,
    contracts: {
      deleteRemoteStatus: async () => ok(deleted),
      publishRemoval: async (_actorUri: string, status: RemovedRemoteStatus) => {
        published.push(status);
      },
      withdrawRemoteNotifications: async (withdrawal: RemoteNotificationWithdrawal) => {
        withdrawn.push(withdrawal);
        return ok(1);
      },
    },
  };
};

describe("withdrawRemoteStatus", () => {
  it("announces the removal and withdraws the status's mention notifications", async () => {
    const store = recording(removed);
    const result = await withdrawRemoteStatus(store.contracts, actorUri, {
      kind: "ObjectUri",
      objectUri: "https://remote.example/notes/1",
    });
    expect(result.isOk() && result.value).toBe(true);
    expect(store.published).toEqual([removed]);
    expect(store.withdrawn).toEqual([{ actorUri, kinds: ["mention"], statusId: "500" }]);
  });

  it("leaves everything alone when the actor wrote no such status", async () => {
    const store = recording(undefined);
    const result = await withdrawRemoteStatus(store.contracts, actorUri, { kind: "Id", id: "500" });
    expect(result.isOk() && result.value).toBe(false);
    expect(store.published).toEqual([]);
    expect(store.withdrawn).toEqual([]);
  });

  it("returns the delete failure without announcing anything", async () => {
    const store = recording(removed);
    const failure: RepositoryError = { kind: "RepositoryError", message: "down" };
    const result = await withdrawRemoteStatus(
      { ...store.contracts, deleteRemoteStatus: async () => err(failure) },
      actorUri,
      { kind: "Id", id: "500" },
    );
    expect(result.isErr() ? result.error : undefined).toEqual(failure);
    expect(store.published).toEqual([]);
  });
});
