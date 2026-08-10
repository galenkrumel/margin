// Thin typed helpers over D1 (env.DB). No ORM -- these are the dozen or so
// queries the API and the workflow actually need, hand-written prepared
// statements + batch(). JSON.parse/stringify happens ONLY at this layer;
// everyone else deals in plain objects.
//
// Also home for the two shared type blocks (Env, the STATE blob) that api.ts
// and workflow.ts both need -- small enough that a separate types.ts would
// just be one more file to open. D1Database/Fetcher/Workflow etc. are ambient
// globals from @cloudflare/workers-types (wired up by tsconfig.json).

// ---- Env --------------------------------------------------------------------

export interface Env {
  DB: D1Database;
  MEASURE: Workflow<MeasureParams>;
  ASSETS: Fetcher;
  MARGIN_TOKENS: string;      // "tenant:secret,tenant2:secret2" -- HTTP Basic, see authTenant() in api.ts
  EVEROS_BASE_URL: string;
  EVEROS_API_KEY?: string;    // unset -> memory writes stay local-only (memory_store.py:73-75)
  OPENAI_API_KEY?: string;    // optional house-tenant fallback; BYOK (request body openai_key) is the default path
}

// Lives here rather than workflow.ts so this file doesn't have to import that
// one just to type Env.MEASURE.
export interface MeasureParams {
  jobId: string;
  tenant: string;
  requested: RequestedJob;
  openaiKey: string;
  /** Set only by a resume: the convergence points the job already paid for, so
   * the run appends to that curve instead of restarting it. Carried in params
   * rather than re-read from the job row because params are frozen for the
   * instance's life -- a replay after a mid-run deploy sees the same value,
   * where a fresh read would see the row this very run has been updating and
   * double-count its own points. */
  trajectory?: TrajectoryPoint[];
}

// ---- the STATE blob: api.py's in-memory STATE[job_id], now the `result` column --

export interface Prompt { id?: string | null; text: string; meta?: Record<string, unknown> }

export interface MetricConfig {   // the metric block, opaque-ish -- scorer.py/scorers.ts own its shape
  name?: string;
  aggregate_field: string;
  scorer:
    | { type: 'function'; name: string }
    | { type: 'llm_judge'; model: string; system: string; fields: Record<string, string> };
  labels?: string[] | null;
  regex_validator?: Record<string, string[]>;
}

export interface RequestedJob {   // api.py:73-79 JobRequest
  prompts: (string | Prompt)[];
  metric: MetricConfig;
  measured: {                     // api.py:44-49 Measured
    model: string;
    web_search: boolean;
    max_output_tokens: number;
    reasoning_effort?: string | null;
  };
  precision: { ci_width: number; confidence: number };   // api.py:52-55 Precision
  budget: { max_executions: number; max_usd: number };   // api.py:57-59 Budget
  batch: number;                                         // api.py:79
  // cloud-only BYOK addition (api.py reads OPENAI_API_KEY from the process env
  // instead, since it's single-tenant). Never persisted -- api.ts builds
  // `requested` without this field; it only ever exists in the POST body and
  // as MeasureParams.openaiKey.
  openai_key?: string;
}

export interface TrajectoryPoint { n: number; p: number; lo: number; hi: number }

export interface MemoryPrior {
  baseline_n: number;
  baseline_rate: number;
  n_eff: number;
  recall_mode: string;
  drift: string | null;
}

export interface JobState {   // api.py:316-322 (create) + :286-301 (per-batch update)
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: string | null;
  executions_used: number;
  k: number;
  estimate: number | null;
  ci: [number, number] | null;
  ci_width: number | null;
  cost_usd: number;
  cost_naive_usd: number | null;
  population: number;
  trajectory: TrajectoryPoint[];
  stop_reason: string | null;
  error: string | null;
  memory_prior: MemoryPrior | null;
  interval: 'wilson' | 'credible';
  requested: RequestedJob;
  memory?: { ok: boolean; mode: string; status?: number; error?: string } | null;   // api.py:218 run_job()
  failures: { generate: number; judge: number } | null;   // visible error accounting, cloud-only addition
}

/** api.py:316-322 -- the record a brand-new job starts life as. Shared by
 * api.ts (writes it synchronously so POST /jobs can return right away) and
 * workflow.ts (keeps its own mutable copy as the run progresses). */
export function initialJobState(id: string, requested: RequestedJob): JobState {
  return {
    id, status: 'queued', stage: 'starting',
    executions_used: 0, k: 0, estimate: null, ci: null, ci_width: null,
    cost_usd: 0, cost_naive_usd: null, population: requested.prompts.length,
    trajectory: [], stop_reason: null, error: null,
    memory_prior: null, interval: 'wilson', requested, failures: null,
  };
}

// ---- per-row shapes (responses/scores stay row-per-prompt, not JSON blobs) --

export interface ResponseRow {
  qid: string; ok: boolean; text: string;
  tokens_in: number; tokens_out: number; searches: number;
  cost: number; error: string | null;
}

export interface ScoreRow {
  qid: string; flag: boolean; gen_cost: number; judge_cost: number;
  score: Record<string, unknown> | null; score_error: string | null;
}

export interface MeasurementInput {
  metric: string; job_id: string; tenant: string; mode: string; model_version: string | null;
  n: number; k: number; rate: number; ci_lo: number; ci_hi: number; cost: number; ts: number;
  extra?: Record<string, unknown>;
}

export interface Baseline { model_version: string | null; n: number; k: number; rate: number }

// ---- jobs ---------------------------------------------------------------

export async function createJob(db: D1Database, tenant: string, state: JobState): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO jobs (id, tenant, status, requested, result, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(state.id, tenant, state.status, JSON.stringify(state.requested), JSON.stringify(state), now, now).run();
}

export async function getJob(db: D1Database, tenant: string, id: string): Promise<JobState | null> {
  const row = await db.prepare(`SELECT result FROM jobs WHERE id = ? AND tenant = ?`)
    .bind(id, tenant).first<{ result: string }>();
  return row ? (JSON.parse(row.result) as JobState) : null;
}

export async function listJobs(db: D1Database, tenant: string): Promise<JobState[]> {
  const { results } = await db.prepare(
    `SELECT result FROM jobs WHERE tenant = ? ORDER BY created_at DESC`
  ).bind(tenant).all<{ result: string }>();
  return results.map(r => JSON.parse(r.result) as JobState);
}

export async function updateJobResult(db: D1Database, id: string, state: JobState): Promise<void> {
  await db.prepare(
    `UPDATE jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?`
  ).bind(state.status, JSON.stringify(state), Date.now(), id).run();
}

/** Take ownership of an errored job for a resume, atomically. The guard and the
 * status flip are one statement, so of two overlapping resume requests exactly
 * one sees changes=1 -- without that both would pass a separate status check,
 * both clear the failed rows, and both start a workflow on the same jobId,
 * paying twice for every missing prompt. Callers must do the clear and the
 * createInstance only after this returns true. */
export async function claimResume(db: D1Database, id: string, state: JobState): Promise<boolean> {
  // RETURNING, not meta.changes: local D1 (miniflare, i.e. `wrangler dev`)
  // hands back a meta with only `duration` on an UPDATE, so a changes-based
  // guard reads 0 and refuses every resume. A returned row is the same answer
  // in both environments because it's SQL, not runtime metadata.
  const { results } = await db.prepare(
    `UPDATE jobs SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'error' RETURNING id`
  ).bind(state.status, JSON.stringify(state), Date.now(), id).all<{ id: string }>();
  return results.length > 0;
}

// ---- responses ------------------------------------------------------------

export async function insertResponses(db: D1Database, jobId: string, rows: ResponseRow[]): Promise<void> {
  if (!rows.length) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO responses (job_id, qid, ok, text, tokens_in, tokens_out, searches, cost, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await db.batch(rows.map(r =>
    stmt.bind(jobId, r.qid, r.ok ? 1 : 0, r.text, r.tokens_in, r.tokens_out, r.searches, r.cost, r.error)));
}

/** Drop what a failed attempt left behind, so a resumed job re-runs exactly the
 * prompts that failed and pays for nothing else. Required, not cosmetic: the
 * generate/score steps skip any qid already present (that's what makes a step
 * retry resumable), so without this a resume finds every qid written and does
 * nothing. Returns the row count, which is the "retrying N prompts" answer. */
export async function clearFailures(db: D1Database, jobId: string): Promise<number> {
  const [resp, sc] = await db.batch<{ qid: string }>([   // RETURNING for the same reason as claimResume
    db.prepare(`DELETE FROM responses WHERE job_id = ? AND ok = 0 RETURNING qid`).bind(jobId),
    db.prepare(`DELETE FROM scores WHERE job_id = ? AND score IS NULL RETURNING qid`).bind(jobId),
  ]);
  return resp.results.length + sc.results.length;
}

export async function listResponses(db: D1Database, jobId: string): Promise<ResponseRow[]> {
  const { results } = await db.prepare(
    `SELECT qid, ok, text, tokens_in, tokens_out, searches, cost, error FROM responses WHERE job_id = ?`
  ).bind(jobId).all<{
    qid: string; ok: number; text: string; tokens_in: number; tokens_out: number;
    searches: number; cost: number; error: string | null;
  }>();
  return results.map(r => ({ ...r, ok: !!r.ok }));
}

// ---- scores -----------------------------------------------------------------

export async function insertScores(db: D1Database, jobId: string, rows: ScoreRow[]): Promise<void> {
  if (!rows.length) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO scores (job_id, qid, flag, gen_cost, judge_cost, score, score_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  await db.batch(rows.map(r =>
    stmt.bind(jobId, r.qid, r.flag ? 1 : 0, r.gen_cost, r.judge_cost,
      r.score === null ? null : JSON.stringify(r.score), r.score_error)));
}

export async function listScores(db: D1Database, jobId: string): Promise<ScoreRow[]> {
  const { results } = await db.prepare(
    `SELECT qid, flag, gen_cost, judge_cost, score, score_error FROM scores WHERE job_id = ?`
  ).bind(jobId).all<{
    qid: string; flag: number; gen_cost: number; judge_cost: number;
    score: string | null; score_error: string | null;
  }>();
  return results.map(r => ({ ...r, flag: !!r.flag, score: r.score ? JSON.parse(r.score) : null }));
}

// ---- measurements / memory ---------------------------------------------------

/** Most recent measurement for (metric, tenant) -- the warm-start baseline
 * (api.py:242-251 MemoryStore().recall_baseline, minus the live EverOS search:
 * api.py's own numbers always come from the mirror too, per memory_store.py:108). */
export async function latestBaseline(db: D1Database, metric: string, tenant: string): Promise<Baseline | null> {
  const row = await db.prepare(
    `SELECT model_version, n, k, rate FROM measurements
     WHERE metric = ? AND tenant = ? ORDER BY ts DESC LIMIT 1`
  ).bind(metric, tenant).first<Baseline>();
  return row ?? null;
}

export async function insertMeasurement(db: D1Database, m: MeasurementInput): Promise<void> {
  await db.prepare(
    `INSERT INTO measurements (metric, job_id, tenant, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.metric, m.job_id, m.tenant, m.mode, m.model_version, m.n, m.k, m.rate, m.ci_lo, m.ci_hi, m.cost, m.ts,
    m.extra && Object.keys(m.extra).length ? JSON.stringify(m.extra) : null).run();
}

/** GET /memory shape (api.py:339-346): mirror.jsonl lines filtered to mode.
 * `extra`'s keys get spread back to the top level so the response looks
 * exactly like a mirror.jsonl record again. */
export async function listMeasurements(db: D1Database, tenant: string, mode: string): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare(
    `SELECT metric, job_id, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra
     FROM measurements WHERE tenant = ? AND mode = ? ORDER BY ts ASC`
  ).bind(tenant, mode).all<{
    metric: string; job_id: string; mode: string; model_version: string | null;
    n: number; k: number; rate: number; ci_lo: number; ci_hi: number; cost: number; ts: number;
    extra: string | null;
  }>();
  return results.map(({ extra, ...rest }) => ({ ...rest, ...(extra ? JSON.parse(extra) : {}) }));
}
