import { z } from "zod";

export const brandedNonEmptyString = <Brand extends symbol>() =>
  z.string().trim().min(1).brand<Brand>();
