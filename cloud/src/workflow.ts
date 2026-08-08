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
import { priorFromBaseline, decide, canAfford, DRIFT_Z } from './stats';
import { REGISTRY, coerce } from './scorers';
import { generate, judge } from './openai';

const MAX_CONCURRENT = 15;   // fan-out cap for both generate() and judge() calls
const round4 = (x: number) => Math.round(x * 10000) / 10000;

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
    const { jobId, tenant, requested, openaiKey } = event.payload;
    const db = this.env.DB;
    const metric = requested.metric;
    const aggField = metric.aggregate_field;
    const queries = normalizePrompts(requested.prompts);
    const cap = Math.min(requested.budget.max_executions, queries.length);   // api.py:254

    const state: JobState = initialJobState(jobId, requested);
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
          // ponytail: api.py also fires a live EverOS *search* here purely to
          // prove the memory layer is real -- the actual prior always comes
          // from the mirror regardless (memory_store.py:108-118, "authoritative
          // numbers from mirror"). Skipping that ping changes no math. Add a
          // step here if the demo specifically wants to show the round-trip.
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
        state.stage = `generating ${attempted + batchSize}/${cap}`;   // api.py:262
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
            await insertResponses(db, jobId, gen.map(({ qid, r }) => {
              const text = (r.response || '').trim();
              // scorer.py:199-201: "completed" with text, or "incomplete" long
              // enough to salvage. Anything else (error, empty) is not ok.
              const ok = !r.error && !!text
                && (r.status === 'completed' || (r.status === 'incomplete' && text.length > 200));
              return {
                qid, ok, text: r.response,
                tokens_in: r.inputTokens, tokens_out: r.outputTokens,
                searches: r.searchCalls, cost: r.cost, error: r.error,
              };
            }));
          }
          return have.size + todo.length;
        });

        state.stage = `scoring ${attempted}/${cap}`;   // api.py:265
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
          await insertScores(db, jobId, rows);
        });

        // ---- Wilson/credible + stop rule -- plain math, NOT a step (api.py:271-301) --
        const scored = (await listScores(db, jobId)).filter(s => s.score !== null);   // api.py:129 skips score==null
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

        if (d.stop) {
          state.status = 'done';
          state.stop_reason = d.stop;
          state.stage = null;
          await updateJobResult(db, jobId, state);
          break;
        }
        await updateJobResult(db, jobId, state);
      }

      // ---- remember: measurement row + best-effort EverOS push -- api.py:199-218 --
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

        let memory: NonNullable<JobState['memory']>;
        if (!this.env.EVEROS_API_KEY) {
          memory = { ok: true, mode: 'local' };   // memory_store.py:73-75 (no key -> local only)
        } else {
          try {
            const payload = {   // memory_store.py:42-46 _add_payload
              session_id: 'margin-measurements',
              messages: [{
                sender_id: 'margin-engine', role: 'user',
                content: 'MEASUREMENT RESULT ' + JSON.stringify({ ...rec, ...extra }),
                timestamp: Date.now(),
              }],
            };
            const r = await fetch(`${this.env.EVEROS_BASE_URL}/api/v2/memory/add`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${this.env.EVEROS_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            memory = { ok: r.status >= 200 && r.status < 300, mode: 'live', status: r.status };
          } catch (e) {
            // swallow all errors -- the `measurements` insert above already
            // has the durable local copy. memory_store.py:84-87
            memory = { ok: true, mode: 'local', error: String(e).slice(0, 200) };
          }
        }
        state.memory = memory;
        await updateJobResult(db, jobId, state);
      });
    } catch (e) {
      // api.py:267-269's rc!=0 branch: whole-job failure, not a per-row one
      state.status = 'error';
      state.stage = null;
      state.error = String(e instanceof Error ? e.stack || e.message : e).slice(0, 400);
      await updateJobResult(db, jobId, state);
      throw e;   // let the Workflow instance itself record the failure too
    }
  }
}
