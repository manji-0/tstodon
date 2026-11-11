import { type HostResolver, setDefaultHostResolver } from "../server/remote-dns";

const PUBLIC_ADDRESS = "93.184.216.34";

/**
 * Runs `run` with the default host resolver answering `answers` (hostname to
 * addresses); any other name resolves to a public address, as in
 * `apply-migrations.ts`. The public default is put back afterwards.
 */
export const withHostAddresses = async (
  answers: Readonly<Record<string, ReadonlyArray<string>>>,
  run: () => Promise<void>,
): Promise<void> => {
  const resolver: HostResolver = async (host) => ({
    kind: "Resolved",
    addresses: answers[host] ?? [PUBLIC_ADDRESS],
  });
  setDefaultHostResolver(resolver);
  try {
    await run();
  } finally {
    setDefaultHostResolver(async () => ({ kind: "Resolved", addresses: [PUBLIC_ADDRESS] }));
  }
};
