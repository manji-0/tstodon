/**
 * The ActivityPub documents tstodon sends and serves (`@tstodon/api/activitypub`),
 * as Zod schemas with their inferred types: actors, notes and questions, the
 * activities it delivers, its collections, and the WebFinger and NodeInfo
 * discovery documents. These describe tstodon's own output, the shapes
 * Mastodon's serializers produce; reading other servers' documents is
 * lenient and lives in the Worker (`server/activitypub-wire.ts`).
 */
export * from "./context";
export * from "./actor";
export * from "./note";
export * from "./activity";
export * from "./collection";
export * from "./discovery";
