import { err, ok, type Result } from "neverthrow";
import { provisionAccountFromEmail } from "./account-store";
import type { LocalAccount } from "@tstodon/domain";
import type { RepositoryError } from "./d1";

export type AuthError =
  | Readonly<{ kind: "MissingToken" }>
  | Readonly<{ kind: "InvalidToken" }>
  | RepositoryError;

export type AuthContext =
  | Readonly<{ kind: "Anonymous" }>
  | Readonly<{ kind: "Account"; account: LocalAccount }>;

const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return header.slice("bearer ".length).trim();
};

export const authenticate = async (
  request: Request,
  env: Env,
): Promise<Result<AuthContext, AuthError>> => {
  const token = bearerToken(request);
  if (!token) {
    return ok({ kind: "Anonymous" });
  }
  const secret = env.DEV_BEARER_SECRET;
  if (!secret) {
    return token ? err({ kind: "InvalidToken" }) : ok({ kind: "Anonymous" });
  }
  if (token.startsWith(`${secret}:`)) {
    const email = token.slice(secret.length + 1);
    const account = await provisionAccountFromEmail(env.DB, email);
    if (account.isErr()) {
      return err(account.error);
    }
    return ok({ kind: "Account", account: account.value });
  }
  return err({ kind: "InvalidToken" });
};

export const requireAccount = async (
  request: Request,
  env: Env,
): Promise<Result<LocalAccount, AuthError>> => {
  const auth = await authenticate(request, env);
  if (auth.isErr()) {
    return err(auth.error);
  }
  if (auth.value.kind !== "Account") {
    return err({ kind: "MissingToken" });
  }
  return ok(auth.value.account);
};
