import { describe, expect, it } from "vite-plus/test";
import {
  ApiNotification,
  ApiQuote,
  ApiStatus,
  isNotificationType,
  isStatusVisibility,
  STATUS_VISIBILITIES,
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
});
