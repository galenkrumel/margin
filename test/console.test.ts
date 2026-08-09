// The launcher quotes real money off these numbers, so the aggregation gets a
// test even though the SQL around it doesn't.
import { describe, expect, it } from "vitest";
import { ratesFrom, type JobCostRow } from "../src/console.js";

const row = (o: Partial<JobCostRow>): JobCostRow =>
  ({ model: "gpt-4o-mini", search: 0, n: 10, gen: 0.01, judge: 0.005, ...o });

describe("ratesFrom", () => {
  it("splits generation-only from generation+judge", () => {
    const { rates, rates_gen } = ratesFrom([row({ n: 10, gen: 0.01, judge: 0.005 })]);
    expect(rates["gpt-4o-mini|0"]).toBeCloseTo(0.0015, 6);      // (0.01+0.005)/10
    expect(rates_gen["gpt-4o-mini|0"]).toBeCloseTo(0.001, 6);   // 0.01/10
  });

  it("keys web_search separately -- a searched run is a different price", () => {
    const { rates } = ratesFrom([
      row({ search: 0, gen: 0.01, judge: 0 }),
      row({ search: 1, gen: 0.20, judge: 0 }),
    ]);
    expect(rates["gpt-4o-mini|0"]).toBeCloseTo(0.001, 6);
    expect(rates["gpt-4o-mini|1"]).toBeCloseTo(0.02, 6);
  });

  it("keeps the max per combo, not the mean -- quotes read high, never low", () => {
    const { rates } = ratesFrom([
      row({ gen: 0.01, judge: 0 }),   // 0.001/query
      row({ gen: 0.05, judge: 0 }),   // 0.005/query  <- the one that must survive
      row({ gen: 0.02, judge: 0 }),
    ]);
    expect(rates["gpt-4o-mini|0"]).toBeCloseTo(0.005, 6);
  });

  it("skips rows that would divide by zero or have no model", () => {
    expect(ratesFrom([row({ n: 0 }), row({ model: null })]).rates).toEqual({});
  });

  it("returns empty maps for a tenant with no jobs -- the console then says so", () => {
    expect(ratesFrom([])).toEqual({ rates: {}, rates_gen: {} });
  });
});
