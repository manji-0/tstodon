// A stand-in remote Mastodon server for the browser e2e: one account,
// `remote_alice@127.0.0.1:8794`, published the way Mastodon publishes it
// (WebFinger, an ActivityPub Person with a key and avatar, an outbox with a
// public note). Inbox deliveries are accepted and dropped. Signatures on
// incoming fetches are not checked.
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";

const PORT = 8794;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const USERNAME = "remote_alice";
const ACTOR = `${ORIGIN}/users/${USERNAME}`;

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

// A 1x1 PNG, for the avatar.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const note = {
  id: `${ACTOR}/statuses/1`,
  type: "Note",
  attributedTo: ACTOR,
  content: "<p>Greetings from the remote server</p>",
  published: "2026-10-01T00:00:00Z",
  url: `${ORIGIN}/@${USERNAME}/1`,
  to: ["https://www.w3.org/ns/activitystreams#Public"],
  cc: [`${ACTOR}/followers`],
  tag: [],
  attachment: [],
};

const documents = {
  [`/users/${USERNAME}`]: {
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: ACTOR,
    type: "Person",
    preferredUsername: USERNAME,
    name: "Remote Alice",
    summary: "<p>I live on another server.</p>",
    url: `${ORIGIN}/@${USERNAME}`,
    published: "2026-01-01T00:00:00Z",
    manuallyApprovesFollowers: false,
    discoverable: true,
    inbox: `${ACTOR}/inbox`,
    outbox: `${ACTOR}/outbox`,
    followers: `${ACTOR}/followers`,
    following: `${ACTOR}/following`,
    endpoints: { sharedInbox: `${ORIGIN}/inbox` },
    icon: { type: "Image", mediaType: "image/png", url: `${ORIGIN}/avatar.png` },
    publicKey: { id: `${ACTOR}#main-key`, owner: ACTOR, publicKeyPem },
  },
  [`/users/${USERNAME}/outbox`]: {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ACTOR}/outbox`,
    type: "OrderedCollection",
    totalItems: 1,
    orderedItems: [
      {
        id: `${note.id}/activity`,
        type: "Create",
        actor: ACTOR,
        published: note.published,
        to: note.to,
        cc: note.cc,
        object: note,
      },
    ],
  },
  [`/users/${USERNAME}/statuses/1`]: {
    "@context": "https://www.w3.org/ns/activitystreams",
    ...note,
  },
  [`/users/${USERNAME}/followers`]: {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ACTOR}/followers`,
    type: "OrderedCollection",
    totalItems: 0,
    orderedItems: [],
  },
  [`/users/${USERNAME}/following`]: {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ACTOR}/following`,
    type: "OrderedCollection",
    totalItems: 0,
    orderedItems: [],
  },
};

const json = (res, status, body, type = "application/activity+json") => {
  res.writeHead(status, { "content-type": type });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  if (req.method === "POST") {
    req.resume();
    res.writeHead(202).end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (url.pathname === "/avatar.png") {
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    return;
  }
  if (url.pathname === "/.well-known/webfinger") {
    const resource = url.searchParams.get("resource") ?? "";
    if (resource !== `acct:${USERNAME}@127.0.0.1:${PORT}` && resource !== ACTOR) {
      res.writeHead(404).end();
      return;
    }
    json(
      res,
      200,
      {
        subject: `acct:${USERNAME}@127.0.0.1:${PORT}`,
        aliases: [ACTOR],
        links: [{ rel: "self", type: "application/activity+json", href: ACTOR }],
      },
      "application/jrd+json",
    );
    return;
  }
  const document = documents[url.pathname];
  if (document) {
    json(res, 200, document);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1");
