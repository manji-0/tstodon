import { err, ok, type Result } from "neverthrow";

/**
 * Path-safe Mastodon account id for a remote actor.
 *
 * Remote actors are addressed by their ActivityPub URI, which contains `:` and
 * `/` and therefore cannot be a raw path segment. `r_` + base64url(actorUri)
 * gives a reversible id safe to place in `/api/v1/accounts/:id` style paths.
 */
const PREFIX = "r_";

const encodeBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decodeBase64Url = (value: string): string | undefined => {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

export type RemoteAccountIdError = Readonly<{ kind: "NotRemoteAccountId" }>;

export const RemoteAccountId = {
  prefix: PREFIX,
  encode: (actorUri: string): string => `${PREFIX}${encodeBase64Url(actorUri)}`,
  decode: (id: string): Result<string, RemoteAccountIdError> => {
    if (!id.startsWith(PREFIX)) {
      return err({ kind: "NotRemoteAccountId" });
    }
    const actorUri = decodeBase64Url(id.slice(PREFIX.length));
    if (actorUri === undefined || actorUri.length === 0) {
      return err({ kind: "NotRemoteAccountId" });
    }
    return ok(actorUri);
  },
} as const;
