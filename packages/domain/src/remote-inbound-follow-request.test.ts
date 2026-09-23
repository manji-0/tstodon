import { describe, expect, it } from "vitest";
import { RemoteInboundFollowRequest } from "./remote-inbound-follow-request";

describe("RemoteInboundFollowRequest", () => {
  it("queues locked targets and fulfills unlocked ones after inbox Follow", () => {
    expect(RemoteInboundFollowRequest.afterInboxFollow(true)).toEqual(
      RemoteInboundFollowRequest.Queued,
    );
    expect(RemoteInboundFollowRequest.afterInboxFollow(false)).toEqual(
      RemoteInboundFollowRequest.Fulfilled,
    );
  });

  it("authorize only advances Queued to Fulfilled", () => {
    expect(RemoteInboundFollowRequest.authorize(RemoteInboundFollowRequest.Queued)).toEqual(
      RemoteInboundFollowRequest.Fulfilled,
    );
    expect(RemoteInboundFollowRequest.authorize(RemoteInboundFollowRequest.Absent)).toEqual(
      RemoteInboundFollowRequest.Absent,
    );
    expect(RemoteInboundFollowRequest.authorize(RemoteInboundFollowRequest.Fulfilled)).toEqual(
      RemoteInboundFollowRequest.Fulfilled,
    );
  });

  it("reject only clears Queued to Absent", () => {
    expect(RemoteInboundFollowRequest.reject(RemoteInboundFollowRequest.Queued)).toEqual(
      RemoteInboundFollowRequest.Absent,
    );
    expect(RemoteInboundFollowRequest.reject(RemoteInboundFollowRequest.Fulfilled)).toEqual(
      RemoteInboundFollowRequest.Fulfilled,
    );
    expect(RemoteInboundFollowRequest.reject(RemoteInboundFollowRequest.Absent)).toEqual(
      RemoteInboundFollowRequest.Absent,
    );
  });
});
