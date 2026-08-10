// Ported from runner.py (generation) + scorer.py (judging): pricing table,
// cost formula, and the two retry policies. No node builtins -- fetchImpl
// defaults to globalThis.fetch so this runs in a Cloudflare Worker unchanged.

const API = "https://api.openai.com/v1";

// [prompt $/1M tokens, completion $/1M tokens] -- runner.py:24 / scorer.py:26
export const PRICES: Record<string, [number, number]> = {
  "gpt-5": [1.25, 10.0],
  "gpt-4o": [2.5, 10.0],
  "gpt-4o-mini": [0.15, 0.6],
};

export const SEARCH_FEE = 0.01; // runner.py:25, $ per web_search call

/** Longest-prefix match on model name (runner.py:29-33 / scorer.py:81-85). */
export function price(model: string): [number, number] {
  const keys = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (model.startsWith(k)) return PRICES[k];
  }
  throw new Error(`no price for ${model} -- add to PRICES`);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** runner.py:80 cost formula. */
export function cost(model: string, tokensIn: number, tokensOut: number, searches = 0): number {
  const [pi, po] = price(model);
  return round6((tokensIn / 1e6) * pi + (tokensOut / 1e6) * po + searches * SEARCH_FEE);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Failures no retry can fix: a revoked key, a quota only a human can top up,
 * a model the account can't see. Matched on the message rather than the status
 * because OpenAI overloads 429 -- rate-limit (retry) and insufficient_quota
 * (retrying only burns the clock) share it, and only the body's `error.code`
 * separates them. Both retry loops below and workflow.ts call this, so the
 * classification lives in one place; it reads the *persisted* error string,
 * which is what lets the workflow's check survive a step replay.
 *
 * "Too many subrequests" is Cloudflare's, not OpenAI's: the per-invocation
 * fetch budget is spent, so every remaining call in THIS invocation fails the
 * same way -- and it isn't even sent, so retrying just sleeps. A resume gets a
 * fresh instance and a fresh budget, which is exactly the recovery path the
 * terminal branch in workflow.ts already points at. Diagnosed on
 * live_1786400361: 50 calls landed, the next 100 died here over ~3 minutes of
 * pointless backoff. */
export function isTerminal(msg: string | null | undefined): boolean {
  return !!msg && (/^(401|403|404):/.test(msg)
    || /insufficient_quota|invalid_api_key|account_deactivated|model_not_found/.test(msg)
    || /Too many subrequests/.test(msg));
}

function extractText(data: any): [text: string, searches: number] {
  const text: string[] = [];
  let searches = 0;
  for (const item of data?.output ?? []) {
    const t = item?.type ?? "";
    if (typeof t === "string" && t.includes("web_search")) searches += 1;
    if (t === "message") {
      for (const c of item?.content ?? []) {
        if (c?.type === "output_text") text.push(c.text ?? "");
      }
    }
  }
  return [text.join("\n"), searches];
}

export interface GenerateConfig {
  model: string;
  webSearch?: boolean;
  maxOutputTokens: number;
  reasoningEffort?: string | null;
}

export interface GenerateResult {
  status: string;
  incompleteDetails?: unknown;
  response: string;
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  cost: number;
  error: string | null;
}

const GEN_MAX_RETRIES = 5; // runner.py:26

/** runner.py:49-92, one query -> one response. */
export async function generate(
  text: string,
  cfg: GenerateConfig,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<GenerateResult> {
  const payload: Record<string, unknown> = {
    model: cfg.model,
    input: text,
    max_output_tokens: cfg.maxOutputTokens,
  };
  if (cfg.webSearch) payload.tools = [{ type: "web_search" }];
  if (cfg.reasoningEffort) payload.reasoning = { effort: cfg.reasoningEffort };

  let result: GenerateResult | null = null;
  // Carried across attempts so a give-up reports the last real reason. Losing
  // it was why 100 failed calls in live_1786374587 all read "retries
  // exhausted" -- a dead key and a busy minute were indistinguishable.
  let lastError = "retries exhausted";
  for (let attempt = 0; attempt < GEN_MAX_RETRIES; attempt++) {
    let r: Response;
    try {
      r = await fetchImpl(`${API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastError = `fetch: ${String(e).slice(0, 200)}`;
      if (isTerminal(lastError)) break;   // a spent subrequest budget won't refill mid-invocation
      await sleep(Math.min(2 ** attempt + Math.random(), 30) * 1000);
      continue;
    }
    if (r.status === 200) {
      const data: any = await r.json();
      const u = data.usage ?? {};
      const [text2, searches] = extractText(data);
      const tin = u.input_tokens ?? 0;
      const tout = u.output_tokens ?? 0;
      result = {
        status: data.status ?? "completed",
        incompleteDetails: data.incomplete_details,
        response: text2,
        inputTokens: tin,
        outputTokens: tout,
        searchCalls: searches,
        cost: cost(cfg.model, tin, tout, searches),
        error: null,
      };
      break;
    }
    if ([429, 500, 502, 503].includes(r.status)) {
      lastError = `${r.status}: ${(await r.text()).slice(0, 200)}`;
      if (isTerminal(lastError)) break;   // 429 insufficient_quota -- four more tries change nothing
      await sleep(Math.min(2 ** attempt + Math.random(), 30) * 1000);
      continue;
    }
    result = {
      status: "error",
      response: "",
      inputTokens: 0,
      outputTokens: 0,
      searchCalls: 0,
      cost: 0,
      error: `${r.status}: ${(await r.text()).slice(0, 200)}`,
    };
    break;
  }
  return result ?? { status: "error", response: "", inputTokens: 0, outputTokens: 0, searchCalls: 0, cost: 0, error: lastError };
}

export interface JudgeResult {
  score: Record<string, unknown> | null;
  judgeCost: number;
  scoreError: string | null;
}

const JUDGE_MAX_RETRIES = 4; // scorer.py:27

/** scorer.py:113-150, one response -> one judged score. */
export async function judge(
  responseText: string,
  scorerCfg: { system: string; fields: Record<string, string> },
  judgeModel: string,
  labels: string[] | null | undefined,
  coerceFn: (fieldsSpec: Record<string, string>, raw: Record<string, unknown>, labels?: string[] | null) => Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<JudgeResult> {
  const payload = {
    model: judgeModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: scorerCfg.system },
      { role: "user", content: `RESPONSE TEXT:\n${responseText.slice(0, 6000)}` },
    ],
  };

  let lastError = "retries exhausted";   // see generate() above
  for (let attempt = 0; attempt < JUDGE_MAX_RETRIES; attempt++) {
    let r: Response;
    try {
      r = await fetchImpl(`${API}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastError = `fetch: ${String(e).slice(0, 150)}`;
      if (isTerminal(lastError)) break;   // see generate() above
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (r.status === 200) {
      const data: any = await r.json();
      const u = data.usage ?? {};
      const [pi, po] = price(judgeModel);
      const judgeCost = round6(
        ((u.prompt_tokens ?? 0) / 1e6) * pi + ((u.completion_tokens ?? 0) / 1e6) * po
      );
      try {
        const raw = JSON.parse(data.choices[0].message.content);
        return { score: coerceFn(scorerCfg.fields, raw, labels), judgeCost, scoreError: null };
      } catch (e) {
        return { score: null, judgeCost, scoreError: `parse: ${String(e)}` };
      }
    }
    if ([429, 500, 502, 503].includes(r.status)) {
      lastError = `${r.status}: ${(await r.text()).slice(0, 150)}`;
      if (isTerminal(lastError)) break;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    return { score: null, judgeCost: 0, scoreError: `${r.status}: ${(await r.text()).slice(0, 150)}` };
  }
  return { score: null, judgeCost: 0, scoreError: lastError };
}
