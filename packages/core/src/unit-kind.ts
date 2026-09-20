import { z } from "zod";

export const unitKind = <const Kind extends string>(kind: Kind) =>
  z.object({
    kind: z.literal(kind),
  });
