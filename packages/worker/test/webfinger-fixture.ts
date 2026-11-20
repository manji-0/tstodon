import { z } from "zod";

const ServedActor = z.object({ id: z.string(), preferredUsername: z.string() });

/**
 * The WebFinger answer a remote server gives for one of the actor documents
 * a test serves, found by the `acct:` resource's username and host; 404 when
 * none matches. Mastodon caches an actor only once this round trip names it
 * (`check_webfinger!`).
 */
export const webfingerAnswer = (
  documents: Readonly<Record<string, unknown>>,
  url: URL,
): Response => {
  const [username, host] = (url.searchParams.get("resource") ?? "")
    .replace(/^acct:/, "")
    .split("@");
  const actor = Object.values(documents)
    .map((document) => ServedActor.safeParse(document))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .find(
      (document) => document.preferredUsername === username && new URL(document.id).host === host,
    );
  return actor
    ? Response.json({
        subject: `acct:${username}@${host}`,
        links: [{ rel: "self", type: "application/activity+json", href: actor.id }],
      })
    : new Response(null, { status: 404 });
};
