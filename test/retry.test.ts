// The retry loops used to throw away *why* a call failed: job
// live_1786374587 recorded 100 failures whose entire stored reason was the
// string "retries exhausted", which made a dead key and a busy minute
// indistinguishable. These lock in the two behaviours that fixed it -- the
// reason survives to the caller, and a terminal reason stops the retrying.
import { describe, expect, it, vi } from "vitest";
import { generate, judge, isTerminal } from "../src/openai.js";

const CFG = { model: "gpt-4o-mini", maxOutputTokens: 400 };
const QUOTA = JSON.stringify({
  error: { message: "You exceeded your current quota", code: "insufficient_quota" },
});

/** Counts calls so a test can assert retries did NOT happen. */
function stub(status: number, body = "{}") {
  const calls: number[] = [];
  const fn = (async () => {
    calls.push(1);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, get n() { return calls.length; } };
}

describe("isTerminal", () => {
  it("catches the 429 that retrying can never fix", () => {
    // OpenAI overloads 429 -- this is the whole reason classification reads the
    // body's error.code and not the status.
    expect(isTerminal(`429: ${QUOTA}`)).toBe(true);
    expect(isTerminal('429: {"error":{"code":"rate_limit_exceeded"}}')).toBe(false);
  });

  it("catches dead keys and unreachable models, ignores transient faults", () => {
    expect(isTerminal("401: invalid_api_key")).toBe(true);
    expect(isTerminal("404: model_not_found")).toBe(true);
    expect(isTerminal("503: upstream unavailable")).toBe(false);
    expect(isTerminal("fetch: TypeError: network error")).toBe(false);
    expect(isTerminal(null)).toBe(false);
  });

  it("anchors the status match so a body quoting '401' is not terminal", () => {
    expect(isTerminal("500: gateway said 401 to someone else")).toBe(false);
  });
});

describe("generate", () => {
  it("stops on the first terminal 429 instead of burning all five attempts", async () => {
    const s = stub(429, QUOTA);
    const r = await generate("q", CFG, "sk-x", s.fn);
    expect(s.n).toBe(1);
    expect(r.error).toContain("insufficient_quota");
  });

  it("keeps the last real reason when it does give up", async () => {
    vi.useFakeTimers();
    const s = stub(503, "upstream unavailable");
    const p = generate("q", CFG, "sk-x", s.fn);
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(s.n).toBe(5);                        // transient -> all retries used
    expect(r.error).toContain("503");           // ...and the reason survived
    expect(r.error).not.toBe("retries exhausted");
  });

  it("preserves a thrown network fault as the reason", async () => {
    vi.useFakeTimers();
    const boom = (async () => { throw new TypeError("connection reset"); }) as unknown as typeof fetch;
    const p = generate("q", CFG, "sk-x", boom);
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(r.error).toContain("connection reset");
  });
});

describe("judge", () => {
  it("stops on the first terminal 429 and keeps the reason", async () => {
    const s = stub(429, QUOTA);
    const r = await judge("text", { system: "s", fields: {} }, "gpt-4o-mini", null, () => ({}), "sk-x", s.fn);
    expect(s.n).toBe(1);
    expect(r.scoreError).toContain("insufficient_quota");
  });
});
