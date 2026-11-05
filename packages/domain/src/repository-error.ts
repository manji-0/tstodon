/**
 * A store or resolver could not reach or read its storage. The read and write
 * contracts beside each concept fail with it; the worker's D1 adapters produce it.
 */
export type RepositoryError = Readonly<{
  kind: "RepositoryError";
  message: string;
}>;
