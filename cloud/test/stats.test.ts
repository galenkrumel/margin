// Every assertion ported verbatim from stats.py's __main__ selfcheck.
import { describe, expect, it } from "vitest";
import { betaCi, nForWidth, wilson } from "../src/stats.js";

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

describe("betaCi at the boundary (a==1 or b==1 -- exact quantiles, not normal approx)", () => {
  it("betaCi(1,41): Beta(1,b) closed-form CDF 1-(1-x)^b", () => {
    const [m, lo, hi] = betaCi(1, 41);
    const expLo = 1 - Math.pow(0.975, 1 / 41);
    const expHi = 1 - Math.pow(0.025, 1 / 41);
    expect(m).toBeCloseTo(1 / 42, 6);
    expect(lo).toBeCloseTo(expLo, 6);
    expect(hi).toBeCloseTo(expHi, 6);
    expect(lo).toBeCloseTo(0.000617, 5);
    expect(hi).toBeCloseTo(0.08604, 4);
  });

  it("betaCi(41,1): Beta(a,1) closed-form CDF x^a, mirrored", () => {
    const [m, lo, hi] = betaCi(41, 1);
    const expLo = Math.pow(0.025, 1 / 41);
    const expHi = Math.pow(0.975, 1 / 41);
    expect(m).toBeCloseTo(41 / 42, 6);
    expect(lo).toBeCloseTo(expLo, 6);
    expect(hi).toBeCloseTo(expHi, 6);
  });

  it("betaCi(1,1): uniform prior still yields [0.025, 0.975] via the a===1 branch", () => {
    const [, lo, hi] = betaCi(1, 1);
    expect(lo).toBeCloseTo(0.025, 6);
    expect(hi).toBeCloseTo(0.975, 6);
  });

  it("betaCi(4,22): regression -- a>1 && b>1 still uses the normal approx", () => {
    const [m, lo, hi] = betaCi(4, 22);
    const expM = 4 / 26;
    const expH = 1.96 * Math.sqrt((4 * 22) / (26 ** 2 * 27));
    expect(m).toBeCloseTo(expM, 6);
    expect(lo).toBeCloseTo(Math.max(0, expM - expH), 6);
    expect(hi).toBeCloseTo(Math.min(1, expM + expH), 6);
  });
});
