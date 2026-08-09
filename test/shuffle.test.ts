// seededShuffle: deterministic Fisher-Yates used to de-cluster prompt order
// before batching (workflow.ts) -- no Math.random/Date, so step retries and
// engine replays must see byte-identical output for a given seed.
import { describe, expect, it } from "vitest";
import { seededShuffle } from "../src/stats.js";

describe("seededShuffle", () => {
  it("returns a permutation: same members, same length", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const out = seededShuffle(items, "job-a");
    expect(out).toHaveLength(items.length);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
  });

  it("same seed -> identical order across two calls", () => {
    const items = Array.from({ length: 120 }, (_, i) => `q-${i}`);
    const a = seededShuffle(items, "live_1786138476");
    const b = seededShuffle(items, "live_1786138476");
    expect(a).toEqual(b);
  });

  it("different seeds -> different order for a 120-element array", () => {
    const items = Array.from({ length: 120 }, (_, i) => `q-${i}`);
    const a = seededShuffle(items, "live_a");
    const b = seededShuffle(items, "live_b");
    expect(a).not.toEqual(b);
  });

  it("empty and single-element arrays don't crash", () => {
    expect(seededShuffle([], "seed")).toEqual([]);
    expect(seededShuffle([42], "seed")).toEqual([42]);
  });
});
