import { describe, expect, it } from "vite-plus/test";
import {
  ApiInitialState,
  ApiNotification,
  ApiQuote,
  ApiStatus,
  ApiStreamingEvent,
  ApiStreamingMessage,
  ApiStreamingWireEvent,
  encodeStreamingEvent,
  isMastodonNotificationType,
  isNotificationType,
  isStatusVisibility,
  STATUS_VISIBILITIES,
  STREAMING_EVENTS,
} from "./index";

const account = {
  id: "1",
  username: "alice",
  acct: "alice",
  url: "https://example.com/@alice",
  uri: "https://example.com/users/alice",
  display_name: "Alice",
  note: "",
  avatar: "https://example.com/a.png",
  avatar_static: "https://example.com/a.png",
  header: "https://example.com/h.png",
  header_static: "https://example.com/h.png",
  avatar_description: "",
  header_description: "",
  locked: false,
  fields: [],
  emojis: [],
  bot: false,
  group: false,
  discoverable: true,
  indexable: false,
  hide_collections: false,
  show_media: true,
  show_media_replies: true,
  show_featured: true,
  feature_approval: { automatic: [], manual: [], current_user: "denied" },
  created_at: "2026-01-01T00:00:00.000Z",
  last_status_at: null,
  statuses_count: 0,
  followers_count: 0,
  following_count: 0,
};

const status = {
  id: "10",
  created_at: "2026-01-01T00:00:00.000Z",
  in_reply_to_id: null,
  in_reply_to_account_id: null,
  sensitive: false,
  spoiler_text: "",
  visibility: "public",
  language: null,
  uri: "https://example.com/users/alice/statuses/10",
  url: null,
  replies_count: 0,
  reblogs_count: 0,
  favourites_count: 0,
  quotes_count: 0,
  edited_at: null,
  content: "<p>hi</p>",
  reblog: null,
  account,
  media_attachments: [],
  mentions: [],
  tags: [],
  emojis: [],
  card: null,
  poll: null,
  quote: null,
  quote_approval: { automatic: ["public"], manual: [], current_user: "automatic" },
  tagged_collections: [],
};

describe("@tstodon/api schemas", () => {
  it("parses a status, a boost and a moved account", () => {
    expect(ApiStatus.safeParse(status).success).toBe(true);
    const boost = { ...status, id: "11", reblog: status };
    expect(ApiStatus.safeParse(boost).success).toBe(true);
    const moved = { ...status, account: { ...account, moved: account } };
    expect(ApiStatus.safeParse(moved).success).toBe(true);
  });

  it("refuses a boost of a boost and an unknown visibility", () => {
    expect(ApiStatus.safeParse({ ...status, reblog: { ...status, reblog: status } }).success).toBe(
      false,
    );
    expect(ApiStatus.safeParse({ ...status, visibility: "limited" }).success).toBe(false);
  });

  it("discriminates quotes on state", () => {
    expect(ApiQuote.safeParse({ state: "pending", quoted_status: null }).success).toBe(true);
    expect(ApiQuote.safeParse({ state: "accepted", quoted_status: null }).success).toBe(false);
    const shallow = { ...status, quote: { state: "accepted", quoted_status_id: "9" } };
    expect(ApiQuote.safeParse({ state: "accepted", quoted_status: shallow }).success).toBe(true);
  });

  it("discriminates notifications on type", () => {
    const base = { id: "1", created_at: status.created_at, group_key: "ungrouped-1", account };
    expect(ApiNotification.safeParse({ ...base, type: "favourite", status }).success).toBe(true);
    expect(ApiNotification.safeParse({ ...base, type: "follow" }).success).toBe(true);
    expect(ApiNotification.safeParse({ ...base, type: "move" }).success).toBe(false);
    expect(ApiNotification.safeParse({ ...base, type: "nope" }).success).toBe(false);
  });

  it("guards the shared values", () => {
    expect(STATUS_VISIBILITIES.every(isStatusVisibility)).toBe(true);
    expect(isStatusVisibility("limited")).toBe(false);
    expect(isNotificationType("admin.report")).toBe(true);
    expect(isNotificationType("move")).toBe(true);
    expect(isNotificationType("reaction")).toBe(false);
  });

  it("decodes streaming events and refuses what Mastodon does not send", () => {
    const parse = (wire: unknown) => ApiStreamingWireEvent.safeParse(wire).success;
    const update = encodeStreamingEvent({ event: "update", payload: ApiStatus.parse(status) });
    expect(update).toEqual({ event: "update", payload: JSON.stringify(ApiStatus.parse(status)) });
    expect(ApiStreamingWireEvent.parse(update)).toMatchObject({
      event: "update",
      payload: { id: "10" },
    });
    expect(ApiStreamingMessage.parse({ stream: ["hashtag", "cats"], ...update })).toMatchObject({
      stream: ["hashtag", "cats"],
      event: "update",
      payload: { id: "10" },
    });
    expect(encodeStreamingEvent({ event: "delete", payload: "10" })).toEqual({
      event: "delete",
      payload: "10",
    });
    // Decoded, the payload is the entity; on the wire it is its JSON.
    expect(ApiStreamingEvent.safeParse({ event: "update", payload: status }).success).toBe(true);
    expect(parse({ event: "update", payload: status })).toBe(false);
    expect(parse({ event: "update", payload: "{not json" })).toBe(false);
    expect(parse({ event: "update", payload: JSON.stringify({ id: "1" }) })).toBe(false);
    expect(parse({ event: "notifications_merged", payload: "1" })).toBe(true);
    expect(parse({ event: "notifications_merged", payload: "2" })).toBe(false);
    expect(parse({ event: "filters_changed" })).toBe(true);
    expect(parse({ event: "encrypted_message", payload: "{}" })).toBe(false);
    expect(STREAMING_EVENTS).not.toContain("encrypted_message");
    expect(
      ApiStreamingMessage.safeParse({ stream: [], event: "delete", payload: "1" }).success,
    ).toBe(false);
  });

  it("tells Mastodon's notification types from tstodon's", () => {
    expect(isMastodonNotificationType("mention")).toBe(true);
    expect(isMastodonNotificationType("move")).toBe(false);
  });

  it("parses a signed-out initial state and refuses a wrong meta", () => {
    const meta = {
      access_token: null,
      activity_api_enabled: true,
      admin: null,
      domain: "example.com",
      limited_federation_mode: false,
      locale: "en",
      mascot: null,
      profile_directory: true,
      registrations_open: false,
      repository: "manji-0/tstodon",
      search_enabled: true,
      single_user_mode: false,
      source_url: "",
      sso_redirect: null,
      status_page_url: null,
      streaming_api_base_url: "wss://example.com",
      title: "tstodon",
      landing_page: "trends",
      trends_enabled: true,
      version: "0.1.0",
      terms_of_service_enabled: false,
      local_live_feed_access: "public",
      remote_live_feed_access: "public",
      local_topic_feed_access: "public",
      remote_topic_feed_access: "public",
      auto_play_gif: false,
      display_media: "default",
      reduce_motion: false,
      use_blurhash: true,
    };
    const state = {
      meta,
      compose: {},
      accounts: {},
      media_attachments: { accept_content_types: ["image/png"] },
      settings: {},
      languages: [["en", "English", "English"]],
      features: [],
      push_subscription: null,
    };
    expect(ApiInitialState.safeParse(state).success).toBe(true);
    const withMeta = (change: object) => ({ ...state, meta: { ...meta, ...change } });
    expect(ApiInitialState.safeParse(withMeta({ display_media: "all" })).success).toBe(false);
    expect(
      ApiInitialState.safeParse(withMeta({ local_topic_feed_access: "disabled" })).success,
    ).toBe(false);
    expect(ApiInitialState.safeParse({ ...state, settings: [] }).success).toBe(false);
  });
});
