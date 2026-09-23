import { describe, expect, it } from "vitest";
import { z } from "zod";

const meanNs = (samples: number[]): number => samples.reduce((a, b) => a + b, 0) / samples.length;

const timeNs = (fn: () => void, iterations: number): number => {
  for (let i = 0; i < 2_000; i += 1) {
    fn();
  }
  const samples: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      fn();
    }
    samples.push(((performance.now() - start) * 1e6) / iterations);
  }
  return meanNs(samples);
};

describe("zod compile microbench", () => {
  it("compiled parse is faster than uncompiled for object, union, and nested array shapes", () => {
    const objectSchema = z.object({
      username: z.string(),
      bio: z.string(),
      xp: z.number(),
      level: z.number().int(),
      tags: z.array(z.string()),
    });
    const unionSchema = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("Create"),
        id: z.string(),
        actor: z.string(),
        object: z.string(),
      }),
      z.object({
        kind: z.literal("Follow"),
        id: z.string(),
        actor: z.string(),
        object: z.string(),
      }),
      z.object({ kind: z.literal("Undo"), id: z.string(), actor: z.string(), object: z.string() }),
    ]);
    const nestedSchema = z.array(
      z.object({
        title: z.string(),
        votesCount: z.number().int().nonnegative(),
        meta: z.object({ lang: z.string(), nsfw: z.boolean() }),
      }),
    );

    const compiledObject = z.compile(objectSchema);
    const compiledUnion = z.compile(unionSchema);
    const compiledNested = z.compile(nestedSchema);

    const objectInput = {
      username: "billie",
      bio: "hello",
      xp: 42,
      level: 3,
      tags: ["a", "b", "c"],
    };
    const unionInput = {
      kind: "Follow" as const,
      id: "act-1",
      actor: "https://example.com/users/a",
      object: "https://example.com/users/b",
    };
    const nestedInput = [
      { title: "yes", votesCount: 3, meta: { lang: "en", nsfw: false } },
      { title: "no", votesCount: 1, meta: { lang: "en", nsfw: false } },
      { title: "maybe", votesCount: 0, meta: { lang: "ja", nsfw: true } },
    ];

    const iterations = 25_000;
    const objectRaw = timeNs(() => objectSchema.parse(objectInput), iterations);
    const objectCompiled = timeNs(() => compiledObject.parse(objectInput), iterations);
    const unionRaw = timeNs(() => unionSchema.parse(unionInput), iterations);
    const unionCompiled = timeNs(() => compiledUnion.parse(unionInput), iterations);
    const nestedRaw = timeNs(() => nestedSchema.parse(nestedInput), iterations);
    const nestedCompiled = timeNs(() => compiledNested.parse(nestedInput), iterations);

    expect(objectCompiled).toBeLessThan(objectRaw);
    expect(unionCompiled).toBeLessThan(unionRaw);
    expect(nestedCompiled).toBeLessThan(nestedRaw);
  });
});
