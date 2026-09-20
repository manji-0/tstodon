import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import { LocalFollow } from "./local-follow";
import {
  RemoteInboundFollowRequest,
  RemoteInboundFollowRequestSchema,
} from "./remote-inbound-follow-request";

export const FollowPresenceSchema = z.discriminatedUnion("kind", [
  unitKind("None"),
  unitKind("Pending"),
  unitKind("Accepted"),
]);

export type FollowPresence = z.infer<typeof FollowPresenceSchema>;

const LocalFollowerSchema = z.object({
  kind: z.literal("LocalFollower"),
  targetLocked: z.boolean(),
  follow: FollowPresenceSchema,
});

const RemoteFollowerSchema = z.object({
  kind: z.literal("RemoteFollower"),
  targetLocked: z.boolean(),
  remoteRequest: RemoteInboundFollowRequestSchema,
  follow: FollowPresenceSchema,
});

export const FollowRequestSchema = z.discriminatedUnion("kind", [
  LocalFollowerSchema,
  RemoteFollowerSchema,
]);

export type FollowRequest = z.infer<typeof FollowRequestSchema>;
export type LocalFollowerRequest = z.infer<typeof LocalFollowerSchema>;
export type RemoteFollowerRequest = z.infer<typeof RemoteFollowerSchema>;

const noneFollow = { kind: "None" } as const satisfies FollowPresence;

const toPresence = (follow: LocalFollow): FollowPresence => follow;

export const FollowRequest = {
  schema: FollowRequestSchema,
  parse: schemaResult(FollowRequestSchema),
  initial: (
    kind: "LocalFollower" | "RemoteFollower",
    targetLocked: boolean,
  ): FollowRequest => {
    if (kind === "LocalFollower") {
      return {
        kind: "LocalFollower",
        targetLocked,
        follow: toPresence(LocalFollow.initial(targetLocked)),
      };
    }
    const remoteRequest =
      RemoteInboundFollowRequest.afterInboxFollow(targetLocked);
    return {
      kind: "RemoteFollower",
      targetLocked,
      remoteRequest,
      follow:
        remoteRequest.kind === "Fulfilled" ? LocalFollow.Accepted : noneFollow,
    };
  },
  authorize: (state: FollowRequest): FollowRequest => {
    if (state.kind === "LocalFollower") {
      return {
        ...state,
        follow:
          state.follow.kind === "None"
            ? noneFollow
            : LocalFollow.Accepted,
      };
    }
    const remoteRequest = RemoteInboundFollowRequest.authorize(
      state.remoteRequest,
    );
    return {
      ...state,
      remoteRequest,
      follow:
        remoteRequest.kind === "Fulfilled"
          ? LocalFollow.Accepted
          : state.follow,
    };
  },
  reject: (state: FollowRequest): FollowRequest => {
    if (state.kind === "LocalFollower") {
      return {
        ...state,
        follow: state.follow.kind === "Pending" ? noneFollow : state.follow,
      };
    }
    return {
      ...state,
      remoteRequest: RemoteInboundFollowRequest.reject(state.remoteRequest),
    };
  },
} as const;
