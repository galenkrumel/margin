// The measurement loop, as a Workflow -- so a Worker eviction can't lose an
// in-flight job the way api.py's in-memory STATE would. Mirrors _measure() +
// run_job() in api.py:191-219 field-for-field.
//
// Coded against the actual stats.ts/openai.ts/scorers.ts as landed (read
// directly, not the earlier draft signatures) -- decide() takes an
// `exhausted` flag and returns "population_exhausted" itself, and there's a
// separate canAfford() for api.py:258's pre-batch budget check.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type Env, type MeasureParams, type JobState, type ScoreRow,
  initialJobState, latestBaseline, updateJobResult,
  listResponses, insertResponses, listScores, insertScores, insertMeasurement,
} from './db';
import { priorFromBaseline, decide, canAfford, seededShuffle, DRIFT_Z } from './stats';
import { REGISTRY, coerce } from './scorers';
import { generate, judge, isTerminal, genFailure } from './openai';

const MAX_CONCURRENT = 15;   // fan-out cap for both generate() and judge() calls
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** The only logging in the Worker, and only for failed calls. The job's own
 * `error` field is written for whoever launched the run; this is for whoever
 * has to support it -- `wrangler tail` (or `wrangler dev`'s console) is where
 * you find a failure whose job row has since been re-run or forgotten. */
function log(jobId: string, msg: string): void {
  console.error(`[${jobId}] ${msg}`);
}

/** Run `fn` over `items` with at most `limit` in flight -- runner.py's
 * --concurrency semaphore, worker-pool flavored for a fixed list. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function normalizePrompts(prompts: JobState['requested']['prompts']) {
  // api.py:227-229
  return prompts.map((p, i) => typeof p === 'string'
    ? { id: `q-${String(i).padStart(3, '0')}`, text: p, meta: {} as Record<string, unknown> }
    : { id: p.id || `q-${String(i).padStart(3, '0')}`, text: p.text, meta: p.meta ?? {} });
}

export class MeasureWorkflow extends WorkflowEntrypoint<Env, MeasureParams> {
  async run(event: WorkflowEvent<MeasureParams>, step: WorkflowStep) {
    const { jobId, tenant, requested, openaiKey, trajectory } = event.payload;
    const db = this.env.DB;
    const metric = requested.metric;
    const aggField = metric.aggregate_field;
    // qids come from normalizePrompts BEFORE the shuffle so ids stay tied to
    // the original prompt index (intended: only the sampling order moves)
    const queries = seededShuffle(normalizePrompts(requested.prompts), jobId);
    const cap = Math.min(requested.budget.max_executions, queries.length);   // api.py:254

    const state: JobState = initialJobState(jobId, requested);
    // On a resume, keep the convergence curve the earlier batches already paid
    // for -- this run appends to it. Empty on a first run, so no branch needed.
    state.trajectory = trajectory ?? [];
    state.status = 'running';

    try {
      // ---- warm start: a same-model baseline in memory becomes a discounted prior --
      state.stage = 'recalling memory';   // api.py:241
      const baseline = await step.do('recall baseline', () =>
        latestBaseline(db, metric.name || aggField, tenant));

      let prior: { a0: number; b0: number } | null = null;
      let driftFired = false;
      if (baseline && baseline.model_version === requested.measured.model && baseline.n > 0) {   // api.py:246
        prior = priorFromBaseline({ n: baseline.n, k: baseline.k, rate: baseline.rate });
        state.memory_prior = {
          baseline_n: baseline.n, baseline_rate: baseline.rate,
          n_eff: Math.round(prior.a0 + prior.b0 - 2),   // a0+b0-2 == n*scale; stats.ts already applied PRIOR_CAP
          // api.py also fired a live search at an external memory service here,
          // but its numbers came from the mirror regardless (memory_store.py:
          // 108-118, "authoritative numbers from mirror"). D1 is the mirror.
          recall_mode: 'd1',
          drift: null,
        };
      }
      state.stage = null;
      await updateJobResult(db, jobId, state);

      // ---- batch loop: generate -> score -> decide -- api.py:255-296 -----------
      let attempted = 0;   // rows in `responses`, success or failure -- bounds the loop
      let batchNum = 0;
      let perQ: number | null = null;
      let costSoFar = 0;

      while (attempted < cap) {
        batchNum++;

        // api.py:256-260: a budget cap only checked after spending isn't a
        // cap -- skip a batch we already know we can't afford.
        if (!canAfford(costSoFar, perQ, requested.batch, requested.budget.max_usd)) {
          state.status = 'done';
          state.stop_reason = 'budget_cap';
          state.stage = null;
          await updateJobResult(db, jobId, state);
          break;
        }

        const batchSize = Math.min(requested.batch, cap - attempted);
        // Two counters, because they diverge and only one is the measurement:
        // prompts *attempted* (a failed call still writes a row and still
        // advances this) vs executions_used, rows that actually scored. A run
        // whose calls are all failing used to show a chip sprinting to 120/120
        // with nothing behind it -- live_1786400361 read "generating 120/120"
        // at n=20. api.py:262
        state.stage = `generating ${attempted + batchSize}/${cap} — ${state.executions_used} measured`;
        await updateJobResult(db, jobId, state);

        attempted = await step.do(`generate batch ${batchNum}`, async () => {
          // re-queried every attempt: a step retry naturally skips qids a prior
          // attempt already wrote (runner.py's own "resumable" behavior, api.py:11-12)
          const have = new Set((await listResponses(db, jobId)).map(r => r.qid));
          const todo = queries.filter(q => !have.has(q.id)).slice(0, batchSize);
          if (todo.length) {
            const gen = await pool(todo, MAX_CONCURRENT, async q => {
              const r = await generate(q.text, {
                model: requested.measured.model,
                webSearch: requested.measured.web_search,
                maxOutputTokens: requested.measured.max_output_tokens,
                reasoningEffort: requested.measured.reasoning_effort,
              }, openaiKey);
              return { qid: q.id, r };
            });
            const rows = gen.map(({ qid, r }) => {
              const error = genFailure(r);   // never null when the row is not ok
              return {
                qid, ok: !error, text: r.response,
                tokens_in: r.inputTokens, tokens_out: r.outputTokens,
                searches: r.searchCalls, cost: r.cost, error,
              };
            });
            const bad = rows.filter(r => !r.ok);
            if (bad.length) log(jobId, `generate batch ${batchNum}: ${bad.length}/${rows.length} failed -- ${bad[0].error}`);
            await insertResponses(db, jobId, rows);
          }
          return have.size + todo.length;
        });

        state.stage = `scoring ${attempted}/${cap} — ${state.executions_used} measured`;   // api.py:265
        await updateJobResult(db, jobId, state);

        await step.do(`score batch ${batchNum}`, async () => {
          const [responses, scores] = await Promise.all([listResponses(db, jobId), listScores(db, jobId)]);
          const already = new Set(scores.map(s => s.qid));
          const todo = responses.filter(r => r.ok && !already.has(r.qid));
          if (!todo.length) return;

          let rows: ScoreRow[];
          if (metric.scorer.type === 'function') {
            const fn = REGISTRY[metric.scorer.name];
            rows = todo.map(r => {
              const meta = queries.find(q => q.id === r.qid)?.meta ?? {};
              const score = fn(r.text, meta);
              return { qid: r.qid, flag: Boolean(score[aggField]), gen_cost: r.cost, judge_cost: 0, score, score_error: null };
            });
          } else {
            const sc = metric.scorer;   // {type:'llm_judge', model, system, fields}
            rows = await pool(todo, MAX_CONCURRENT, async r => {
              const jr = await judge(r.text, { system: sc.system, fields: sc.fields },
                sc.model, metric.labels ?? null, coerce, openaiKey);
              return {
                qid: r.qid, flag: jr.score ? Boolean(jr.score[aggField]) : false,
                gen_cost: r.cost, judge_cost: jr.judgeCost, score: jr.score, score_error: jr.scoreError,
              };
            });
          }
          const bad = rows.filter(r => r.score === null);
          if (bad.length) log(jobId, `score batch ${batchNum}: ${bad.length}/${rows.length} failed -- ${bad[0].score_error}`);
          await insertScores(db, jobId, rows);
        });

        // ---- Wilson/credible + stop rule -- plain math, NOT a step (api.py:271-301) --
        // failed calls are invisible to n/k below (they never scored) but not
        // to the stop reason -- a run that failed calls didn't "exhaust" the
        // population, it just stopped trying.
        const [respRows, scoreRows] = await Promise.all([listResponses(db, jobId), listScores(db, jobId)]);
        const genFailed = respRows.filter(r => !r.ok).length;
        const scored = scoreRows.filter(s => s.score !== null);   // api.py:129 skips score==null
        const judgeFailed = scoreRows.length - scored.length;
        const failed = genFailed + judgeFailed;
        const n = scored.length;
        const k = scored.filter(s => s.flag).length;
        const cost = scored.reduce((c, s) => c + (s.gen_cost || 0) + (s.judge_cost || 0), 0);
        perQ = n ? cost / n : null;
        costSoFar = cost;

        const d = decide({
          n, k, cost,
          targetWidth: requested.precision.ci_width, maxUsd: requested.budget.max_usd,
          prior: driftFired ? null : prior,
          baseRate: baseline?.rate ?? null, driftZ: DRIFT_Z,
          exhausted: attempted >= cap,   // decide() folds api.py:298-301's fallback in itself
        });
        if (d.drift && !driftFired) {
          driftFired = true;
          if (state.memory_prior) state.memory_prior.drift = 'fired -- prior discarded, fresh interval';   // api.py:277
        }

        state.executions_used = n;
        state.k = k;
        state.estimate = d.estimate;
        state.ci = [d.lo, d.hi];
        state.ci_width = d.width;
        state.interval = d.interval;
        state.cost_usd = round4(cost);
        state.cost_naive_usd = perQ ? round4(perQ * queries.length) : null;   // api.py:288
        state.trajectory = [...state.trajectory, { n, p: d.estimate, lo: d.lo, hi: d.hi }];   // api.py:289
        state.failures = failed ? { generate: genFailed, judge: judgeFailed } : null;

        // A terminal error isn't a flaky call -- every remaining prompt would
        // fail identically, so grinding through the rest of `cap` just buys a
        // longer wait for the same answer. Stop on the first one and say what
        // it was. Written rows stay put, so /resume finishes the job once the
        // cause is cleared rather than paying for the whole run again. A spent
        // subrequest budget clears by itself: the resume is a new instance.
        const terminal = respRows.find(r => isTerminal(r.error))?.error
          ?? scoreRows.find(s => isTerminal(s.score_error))?.score_error;
        if (terminal) {
          state.status = 'error';
          state.stop_reason = null;
          state.stage = null;
          state.error = `not retryable -- ${terminal.slice(0, 250)}\n`
            + `partial result kept at n=${n}; clear the cause, then POST /jobs/${jobId}/resume to finish the remaining prompts`;
          log(jobId, `stopped at n=${n}, not retryable -- ${terminal}`);
          await updateJobResult(db, jobId, state);
          break;
        }

        if (d.stop === 'population_exhausted' && failed > attempted * 0.1) {
          // ponytail: >10% failed calls makes "population exhausted" a lie -- error
          // out with the partial numbers kept; `remember` skips non-done jobs, so a
          // failure-riddled run never becomes a warm-start baseline. tune if noisy.
          state.status = 'error';
          state.stop_reason = null;
          state.stage = null;
          // `&& r.error` so one legacy row written before genFailure() existed
          // (reasonless, hence the "unknown" this line used to print) can't
          // shadow a later row that does carry its reason.
          const why = respRows.find(r => !r.ok && r.error)?.error ?? scoreRows.find(s => s.score === null)?.score_error;
          state.error = `${genFailed}/${attempted} generate and ${judgeFailed}/${scoreRows.length} judge calls failed after retries -- partial result at n=${n}\n`
            + `first failure: ${(why ?? 'unknown').slice(0, 250)}\n`
            + `POST /jobs/${jobId}/resume to retry just the failed prompts`;
          log(jobId, `stopped at n=${n}, ${genFailed} generate + ${judgeFailed} judge failed -- ${why ?? 'unknown'}`);
          await updateJobResult(db, jobId, state);
          break;
        }

        if (d.stop) {
          state.status = 'done';
          state.stop_reason = d.stop;
          state.stage = null;
          await updateJobResult(db, jobId, state);
          break;
        }
        await updateJobResult(db, jobId, state);
      }

      // ---- remember: the measurement row future runs warm-start from -- api.py:199-218 --
      await step.do('remember', async () => {
        if (state.status !== 'done' || !state.executions_used) return;   // api.py:204
        const rec = {
          metric: metric.name || aggField, job_id: jobId, tenant, mode: 'live',
          model_version: requested.measured.model,
          n: state.executions_used, k: state.k,
          rate: round4(state.estimate ?? 0),
          ci_lo: round4(state.ci?.[0] ?? 0), ci_hi: round4(state.ci?.[1] ?? 0),
          cost: state.cost_usd, ts: Date.now() / 1000,
        };
        const extra: Record<string, unknown> = {};
        if (state.memory_prior && state.interval === 'credible') {   // api.py:212-216
          extra.interval = 'credible';
          extra.prior_n_eff = state.memory_prior.n_eff;
          extra.baseline_n = state.memory_prior.baseline_n;
          extra.baseline_rate = state.memory_prior.baseline_rate;
        }
        await insertMeasurement(db, { ...rec, extra });

        // D1 is the only memory store. Kept in the state blob because the
        // response shape is frozen (see api.ts's header) -- api.py:218 always
        // reported this, and now it is always the local answer.
        state.memory = { ok: true, mode: 'local' };
        await updateJobResult(db, jobId, state);
      });
    } catch (e) {
      // A deploy (wrangler deploy / secret put) resets the engine's Durable
      // Object mid-run; the Workflows runtime then re-invokes run() and
      // replays completed steps from cache -- transient, NOT a job failure.
      // Tombstoning here would kill a job the platform is about to resume.
      const msg = String(e instanceof Error ? e.message : e);
      if (/Durable Object reset|code was updated/i.test(msg)) throw e;
      // api.py:267-269's rc!=0 branch: whole-job failure, not a per-row one
      state.status = 'error';
      state.stage = null;
      state.error = String(e instanceof Error ? e.stack || e.message : e).slice(0, 400);
      await updateJobResult(db, jobId, state);
      throw e;   // let the Workflow instance itself record the failure too
    }
  }
}
