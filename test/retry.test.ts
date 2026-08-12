// The retry loops used to throw away *why* a call failed: job
// live_1786374587 recorded 100 failures whose entire stored reason was the
// string "retries exhausted", which made a dead key and a busy minute
// indistinguishable. These lock in the two behaviours that fixed it -- the
// reason survives to the caller, and a terminal reason stops the retrying.
import { describe, expect, it, vi } from "vitest";
import { generate, judge, isTerminal, genFailure, defaultMaxOutputTokens } from "../src/openai.js";

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

  it("catches a spent Cloudflare subrequest budget", () => {
    // Not OpenAI's error -- the platform's. The call is never sent, so every
    // remaining one in this invocation dies identically. live_1786400361 spent
    // ~3 minutes of backoff on 100 of these. The transient-fetch case above
    // still has to stay false: only THIS fetch failure is terminal.
    expect(isTerminal("fetch: Error: Too many subrequests by single Worker invocation.")).toBe(true);
  });
});

/** A fetch that throws rather than answering -- the subrequest cap never
 * produces a Response at all, which is why it needs its own stub. */
function throwingStub(message: string) {
  const calls: number[] = [];
  const fn = (async () => {
    calls.push(1);
    throw new Error(message);
  }) as unknown as typeof fetch;
  return { fn, get n() { return calls.length; } };
}

describe("generate", () => {
  it("stops on a thrown subrequest-cap error instead of backing off five times", async () => {
    // The throw path used to retry unconditionally: five attempts with
    // exponential sleeps, against a budget that cannot refill mid-invocation.
    const s = throwingStub("Too many subrequests by single Worker invocation.");
    const r = await generate("q", CFG, "sk-x", s.fn);
    expect(s.n).toBe(1);
    expect(r.error).toContain("Too many subrequests");
  });

  it("still retries a genuinely transient thrown fetch error", async () => {
    // The guard against over-reaching: the fix must not turn every throw
    // terminal, only the subrequest one.
    vi.useFakeTimers();
    const s = throwingStub("network error");
    const p = generate("q", CFG, "sk-x", s.fn);
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(s.n).toBe(5);
    expect(r.error).toContain("network error");
  });

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

describe("genFailure", () => {
  const base = { response: "", inputTokens: 10, outputTokens: 0, searchCalls: 0, cost: 0, error: null };

  it("names the reason a 200 came back with no usable text", () => {
    // The live_1786494131 shape: gpt-5 spent all 400 max_output_tokens on
    // reasoning, so the call succeeded, returned nothing, and carried no
    // error -- which the job then reported as "first failure: unknown".
    const why = genFailure({ ...base, status: "incomplete", outputTokens: 384,
                             incompleteDetails: { reason: "max_output_tokens" } });
    expect(why).toContain("max_output_tokens");   // the actionable half: raise the cap
    expect(why).toContain("384");
    expect(why).not.toBeNull();
  });

  it("never returns null for a response the run cannot use", () => {
    // The invariant the "unknown" line depended on: !ok implies a reason.
    expect(genFailure({ ...base, status: "completed" })).not.toBeNull();          // 200, empty body
    expect(genFailure({ ...base, status: "incomplete", response: "short" })).not.toBeNull();
    expect(genFailure({ ...base, status: "error", error: "401: bad key" })).toBe("401: bad key");
  });

  it("passes the two shapes that are usable", () => {
    expect(genFailure({ ...base, status: "completed", response: "an answer" })).toBeNull();
    // salvageable truncation -- scorer.py:199-201 keeps >200 chars
    expect(genFailure({ ...base, status: "incomplete", response: "x".repeat(201) })).toBeNull();
  });
});

describe("defaultMaxOutputTokens", () => {
  // The other half of live_1786494131: genFailure() explains the empty
  // responses, this stops most of them happening. 400 is a fine answer budget
  // and a hopeless answer+reasoning budget.
  it("gives reasoning models room to think and still answer", () => {
    expect(defaultMaxOutputTokens("gpt-5")).toBeGreaterThan(400);
    expect(defaultMaxOutputTokens("gpt-5-mini")).toBeGreaterThan(400);
    expect(defaultMaxOutputTokens("o3-mini")).toBeGreaterThan(400);
  });

  it("leaves non-reasoning models on runner.py's 400", () => {
    // Raising these would only widen a cap they never reach -- and the golden
    // fixtures were recorded at 400.
    expect(defaultMaxOutputTokens("gpt-4o-mini")).toBe(400);
    expect(defaultMaxOutputTokens("gpt-4o")).toBe(400);
  });
});

describe("judge", () => {
  it("stops on the first terminal 429 and keeps the reason", async () => {
    const s = stub(429, QUOTA);
    const r = await judge("text", { system: "s", fields: {} }, "gpt-4o-mini", null, () => ({}), "sk-x", s.fn);
    expect(s.n).toBe(1);
    expect(r.scoreError).toContain("insufficient_quota");
  });

  it("stops on a thrown subrequest-cap error instead of backing off four times", async () => {
    // judge() has its own throw branch with its own truncation, so generate()'s
    // test does not cover it -- and the judge path is not hypothetical:
    // live_1786400361 failed 10 judge calls this exact way.
    const s = throwingStub("Too many subrequests by single Worker invocation.");
    const r = await judge("text", { system: "s", fields: {} }, "gpt-4o-mini", null, () => ({}), "sk-x", s.fn);
    expect(s.n).toBe(1);
    expect(r.scoreError).toContain("Too many subrequests");
  });
});
