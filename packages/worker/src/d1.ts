import { err, ok, type Result } from "neverthrow";

export type RepositoryError = Readonly<{
  kind: "RepositoryError";
  message: string;
}>;

export const runD1 = async <T>(work: () => Promise<T>): Promise<Result<T, RepositoryError>> => {
  try {
    return ok(await work());
  } catch (cause) {
    return err({
      kind: "RepositoryError",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
