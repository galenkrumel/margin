// Every assertion ported verbatim from stats.py's __main__ selfcheck.
import { describe, expect, it } from "vitest";
import { nForWidth, wilson } from "../src/stats.js";

describe("stats selfcheck (stats.py:30-45)", () => {
  it("0/40 refused -> Wilson honestly says up to ~8.8%", () => {
    const [p, lo, hi] = wilson(0, 40);
    expect(p).toBe(0.0);
    expect(lo).toBe(0.0);
    expect(Math.abs(hi - 0.088)).toBeLessThan(0.002);
  });

  it("0/120 -> ~3.1%", () => {
    const [, , hi] = wilson(0, 120);
    expect(Math.abs(hi - 0.031)).toBeLessThan(0.002);
  });

  it("own-brand job: 38/39", () => {
    const [p, lo, hi] = wilson(38, 39);
    expect(Math.abs(p - 0.974)).toBeLessThan(0.001);
    expect(hi).toBeLessThanOrEqual(1.0);
    expect(lo).toBeLessThan(p);
    expect(p).toBeLessThan(hi);
  });

  it("symmetry: k and n-k mirror around 0.5", () => {
    const [, loa, hia] = wilson(30, 100);
    const [, lob, hib] = wilson(70, 100);
    expect(Math.abs(loa - (1 - hib))).toBeLessThan(1e-9);
    expect(Math.abs(hia - (1 - lob))).toBeLessThan(1e-9);
  });

  it("price-list sanity: +/-5pts at p=.5 needs ~384+ queries, more than +/-7", () => {
    expect(nForWidth(0.5, 0.1)).toBeGreaterThan(380);
    expect(380).toBeGreaterThan(nForWidth(0.5, 0.14));
  });
});
