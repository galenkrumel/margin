// Worker fetch handler -- the Cloudflare replacement for api.py's FastAPI app.
// Response shapes are copied field-for-field from api.py so the console works
// unmodified. Confirmed by grepping public/index.html for every field it
// actually dereferences off these responses -- fields may be ADDED here, never
// renamed or removed:
//
//   GET  /jobs, GET /jobs/:id -> s.id s.status s.stage s.executions_used s.k
//     s.estimate s.ci[0] s.ci[1] s.ci_width s.cost_usd s.cost_naive_usd
//     s.population s.trajectory s.stop_reason s.memory_prior s.interval
//     s.requested.metric(.name) s.requested.measured.model
//     s.requested.measured.web_search s.requested.precision.ci_width
//     s.requested.prompts
//   POST /jobs   -> (await r.json()).job_id
//   POST /jobs/:id/resume -> job_id, retrying   (added, not part of api.py)
//   GET  /memory -> b.job_id b.ts b.interval b.prior_n_eff
//   GET  /console -> batch, checks, rates, rates_gen  (see src/console.ts)
//
// No framework (hono etc.) -- six routes and one auth check don't need one.

import {
  type Env, type RequestedJob, type MetricConfig,
  initialJobState, createJob, getJob, listJobs, listMeasurements,
  clearFailures, updateJobResult, claimResume,
} from './db';
import { CHECKS } from './scorers';
import { defaultMaxOutputTokens } from './openai';
import { consolePayload } from './console';

// wrangler requires Workflow classes to be exported from the entrypoint file
// (this one, per wrangler.jsonc's "main") -- not just referenced by binding.
export { MeasureWorkflow } from './workflow';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** "tenant:secret,tenant2:secret2" -> tenant for a matching HTTP Basic
 * username:password pair, or null. Applied to every /jobs and /memory route;
 * GET / (the console) skips it. Basic, not Bearer: the console is a static
 * page whose fetch() calls send no Authorization header -- the browser has to
 * attach it for them, which it only does natively for Basic (after prompting).
 * Plain string equality is fine here -- these are per-tenant shared secrets
 * behind TLS, not a target worth timing-attack hardening. */
function authTenant(request: Request, env: Env): string | null {
  const m = /^Basic\s+(.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  let decoded: string;
  try { decoded = atob(m[1].trim()); } catch { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  for (const pair of (env.MARGIN_TOKENS || '').split(',')) {
    const [tenant, secret] = pair.split(':').map(s => s.trim());
    if (tenant && tenant === user && secret && secret === pass) return tenant;
  }
  return null;
}

/** api.py:304-314 validation, plus a couple of stricter checks that fail the
 * HTTP request instead of blowing up mid-workflow (there's no subprocess
 * stderr to surface here, so failing fast up front matters more). */
function validate(body: any): string | null {
  if (!Array.isArray(body?.prompts) || !body.prompts.length) {
    return 'prompts must be non-empty';   // api.py:306-307
  }
  const metric = body.metric;
  if (!metric || typeof metric !== 'object' || !('aggregate_field' in metric) || !('scorer' in metric)) {
    return 'metric needs scorer + aggregate_field (see jobs/*/job.json)';   // api.py:308-309
  }
  const sc = metric.scorer;
  if (sc?.type === 'function') {
    if (!(sc.name in CHECKS)) {
      return `unknown built-in check ${JSON.stringify(sc.name)} (available: ${Object.keys(CHECKS).join(', ')})`;   // api.py:311-314
    }
  } else if (sc?.type === 'llm_judge') {
    if (!sc.system || !sc.fields) return 'llm_judge scorer needs system + fields';   // stricter than api.py, see header
  } else {
    return 'metric.scorer.type must be "function" or "llm_judge"';
  }
  return null;
}

/** api.py:44-79's pydantic defaults, hand-rolled. */
function fillDefaults(body: any): RequestedJob {
  return {
    prompts: body.prompts,
    metric: body.metric as MetricConfig,
    measured: {
      model: body.measured?.model ?? 'gpt-4o-mini',
      web_search: body.measured?.web_search ?? false,
      max_output_tokens: body.measured?.max_output_tokens
        ?? defaultMaxOutputTokens(body.measured?.model ?? 'gpt-4o-mini'),
      reasoning_effort: body.measured?.reasoning_effort ?? null,
    },
    precision: {
      ci_width: body.precision?.ci_width ?? 0.14,
      confidence: body.precision?.confidence ?? 0.95,
    },
    budget: {
      max_executions: body.budget?.max_executions ?? 200,
      max_usd: body.budget?.max_usd ?? 1.0,
    },
    batch: body.batch ?? 20,
    // openai_key deliberately not carried into this object -- BYOK hygiene,
    // see the `openaiKey` handling in createJobRoute below.
  };
}

async function createJobRoute(request: Request, env: Env, tenant: string): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ detail: 'invalid JSON body' }, 422); }

  const problem = validate(body);
  if (problem) return json({ detail: problem }, 422);

  const openaiKey: string | undefined = body.openai_key || env.OPENAI_API_KEY;
  if (!openaiKey) {
    return json({ detail: 'openai_key required (BYOK) -- or ask the operator to set OPENAI_API_KEY for the house tenant' }, 422);
  }

  const requested = fillDefaults(body);
  const jobId = `live_${Math.floor(Date.now() / 1000)}_${crypto.randomUUID().slice(0, 8)}`;   // api.py:315's live_<ts>, +suffix (Workers can race two creates same-second)
  const state = initialJobState(jobId, requested);   // api.py:316-322

  await createJob(env.DB, tenant, state);
  await env.MEASURE.create({ id: jobId, params: { jobId, tenant, requested, openaiKey } });
  return json({ job_id: jobId });   // api.py:323-324
}

/** Finish a job that errored, paying only for the prompts that failed.
 *
 * The recovery already existed and had no door: the workflow's steps skip any
 * qid already in `responses`/`scores` (that's what makes a step retry
 * resumable), so a fresh Workflow instance pointed at the same job id picks up
 * exactly where the last one stopped. clearFailures() is what makes the failed
 * rows eligible again -- without it every qid is present and the resume is a
 * no-op.
 *
 * BYOK hygiene is unchanged: the key comes from THIS request's body (or the
 * house key), never from anything persisted -- there is nothing stored to
 * resume from, by design. */
async function resumeJobRoute(request: Request, env: Env, tenant: string, id: string): Promise<Response> {
  const state = await getJob(env.DB, tenant, id);
  if (!state) return json({ detail: 'no such job' }, 404);
  if (state.status !== 'error') {
    return json({ detail: `job is ${state.status} -- only errored jobs can be resumed` }, 409);
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body is fine -- house key */ }
  const openaiKey: string | undefined = body?.openai_key || env.OPENAI_API_KEY;
  if (!openaiKey) return json({ detail: 'openai_key required (BYOK)' }, 422);

  // Rebuilt rather than patched: leaving the failed attempt's executions_used,
  // estimate, cost and stop_reason on a job now reported as `queued` is an
  // incoherent read for anyone polling in the window before the workflow
  // persists. The one thing worth keeping is the convergence curve.
  const resumed = initialJobState(id, state.requested);
  resumed.stage = 'resuming';
  resumed.trajectory = state.trajectory;

  // Claim BEFORE clearing anything -- the status guard is what makes two
  // overlapping resumes resolve to one winner, and the loser must not have
  // deleted rows on its way out.
  if (!await claimResume(env.DB, id, resumed)) {
    return json({ detail: 'job is already being resumed' }, 409);
  }

  const retrying = await clearFailures(env.DB, id);
  try {
    // a fresh instance id -- the old one is spent, while the job id (and every
    // row already written under it) stays exactly where it is
    await env.MEASURE.create({
      id: `${id}-r${crypto.randomUUID().slice(0, 8)}`,
      params: { jobId: id, tenant, requested: state.requested, openaiKey, trajectory: state.trajectory },
    });
  } catch (e) {
    // Nothing will ever move this job out of `queued` if the instance never
    // started, and the guard above only accepts `error` -- so put it back
    // rather than wedging it out of reach of every future resume.
    state.status = 'error';
    state.stage = null;
    state.error = `resume failed to start: ${String(e).slice(0, 200)}`;
    await updateJobResult(env.DB, id, state);
    return json({ detail: 'could not start the resume workflow' }, 502);
  }
  return json({ job_id: id, retrying });
}

async function listJobsRoute(env: Env, tenant: string): Promise<Response> {
  return json(await listJobs(env.DB, tenant));   // api.py:327-329
}

async function getJobRoute(env: Env, tenant: string, id: string): Promise<Response> {
  const job = await getJob(env.DB, tenant, id);
  if (!job) return json({ detail: 'no such job' }, 404);   // api.py:334-335
  return json(job);
}

async function memoryRoute(env: Env, tenant: string): Promise<Response> {
  return json(await listMeasurements(env.DB, tenant, 'live'));   // api.py:339-346
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return env.ASSETS.fetch(request);   // the console shell -- api.py:349-353
    }

    // every route but the shell and its static assets is tenant-scoped
    const isApi = url.pathname === '/jobs' || url.pathname.startsWith('/jobs/')
      || url.pathname === '/memory' || url.pathname === '/console';
    if (isApi) {
      const tenant = authTenant(request, env);
      if (!tenant) {
        return new Response(JSON.stringify({ detail: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'WWW-Authenticate': 'Basic realm="margin"' },
        });
      }

      if (request.method === 'POST' && url.pathname === '/jobs') return createJobRoute(request, env, tenant);
      if (request.method === 'POST' && url.pathname.startsWith('/jobs/') && url.pathname.endsWith('/resume')) {
        const id = decodeURIComponent(url.pathname.slice('/jobs/'.length, -'/resume'.length));
        return resumeJobRoute(request, env, tenant, id);
      }
      if (request.method === 'GET' && url.pathname === '/jobs') return listJobsRoute(env, tenant);
      if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
        return getJobRoute(env, tenant, decodeURIComponent(url.pathname.slice('/jobs/'.length)));
      }
      if (request.method === 'GET' && url.pathname === '/memory') return memoryRoute(env, tenant);
      if (request.method === 'GET' && url.pathname === '/console') {
        return json(await consolePayload(env.DB, tenant));
      }
      return json({ detail: 'method not allowed' }, 405);
    }

    return env.ASSETS.fetch(request);   // any other path -- static assets alongside the console
  },
};
