import { describe, expect, it } from "vite-plus/test";
import { OutboxJob } from "./outbox-job";

describe("a queued BackfillRemoteThread job", () => {
  it("reads a job queued before `visited` and `resume` as starting its status afresh", () => {
    const job = OutboxJob.parse({
      kind: "BackfillRemoteThread",
      statusId: "117000000000000000",
      from: { kind: "Level", depth: 2, after: "1", listed: 3, pages: 2, stored: 1 },
    });
    expect(job._unsafeUnwrap()).toEqual({
      kind: "BackfillRemoteThread",
      statusId: "117000000000000000",
      from: { kind: "Level", depth: 2, after: "1", visited: 0, listed: 3, pages: 2, stored: 1 },
    });
  });
});
