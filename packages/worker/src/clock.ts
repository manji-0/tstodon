import { IsoInstant } from "@tstodon/domain";

export const nowIso = (): string => new Date().toISOString();

export const nowInstant = (): IsoInstant => {
  const parsed = IsoInstant.parse(nowIso());
  if (parsed.isErr()) {
    throw new Error("clock produced an invalid instant");
  }
  return parsed.value;
};
