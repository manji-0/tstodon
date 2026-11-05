/**
 * `user`, `@user`, `user@domain` or `@user@domain`, with Mastodon's
 * `USERNAME_RE` for the user part; a domain may carry a port.
 */
const HANDLE_PATTERN = /^@?([A-Za-z0-9_]+(?:[.-]+[A-Za-z0-9_]+)*)(?:@([A-Za-z0-9.-]+(?::\d+)?))?$/;

/** The parts of a handle that {@link HANDLE_PATTERN} accepts; the domain is lower case. */
export const parseAccountHandle = (
  raw: string,
): Readonly<{ username: string; domain: string | undefined }> | undefined => {
  const match = HANDLE_PATTERN.exec(raw.trim());
  const username = match?.[1];
  return match && username ? { username, domain: match[2]?.toLowerCase() } : undefined;
};
