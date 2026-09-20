import { Hono } from "hono";
import { parseInstanceIdentity } from "../runtime-config";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

instanceRoutes.get("/api/v1/instance", (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const instance = identity.value;
  return c.json({
    kind: "MastodonInstance",
    uri: instance.domain,
    title: instance.name,
    short_description: instance.description,
    description: instance.description,
    email: instance.contactEmail,
    version: "0.1.0 (compatible; tstodon)",
    languages: instance.languages,
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    configuration: {
      urls: {
        streaming: `wss://${instance.domain}`,
      },
    },
    thumbnail: instance.thumbnailUrl,
    source_url: instance.sourceUrl,
  });
});
