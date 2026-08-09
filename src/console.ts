// GET /console -- the bootstrap payload for public/index.html.
//
// Everything the console renders otherwise comes from /jobs and /memory; this
// is only the handful of constants those two can't supply: which built-in
// checks exist, the batch size the copy refers to, and the measured $/query
// rates the launcher quotes from.
//
// The rates replace what build_console.py used to bake in from the job files on
// disk: a frozen snapshot that could only get staler. Read from D1 they sharpen
// as the tenant runs more jobs.

import { CHECKS } from './scorers';

/** api.py:78 / fillDefaults() -- prompts per scored batch. */
export const BATCH = 20;

export interface ConsolePayload {
  batch: number;
  checks: { name: string; field: string; label: string; desc: string }[];
  rates: Record<string, number>;      // "model|0|1" -> $/query, generation + judge
  rates_gen: Record<string, number>;  // same, generation only (a built-in check pays no judge)
}

export interface JobCostRow {
  model: string | null;
  search: number | null;   // json_extract gives SQLite 0/1 for a JSON boolean
  n: number;
  gen: number;
  judge: number;
}

/** rate_table() from build_console.py: measured cost per query for each
 * model x web_search combo. Max per combo, not mean -- a quote that reads high
 * is a quote nobody complains about. Pure, so the quote math is testable. */
export function ratesFrom(rows: JobCostRow[]): Pick<ConsolePayload, 'rates' | 'rates_gen'> {
  const rates: Record<string, number> = {};
  const rates_gen: Record<string, number> = {};
  for (const r of rows) {
    if (!r.model || !r.n) continue;
    // the console keys on the same "model|0" / "model|1" string it builds from
    // the form controls
    const key = `${r.model}|${r.search ? 1 : 0}`;
    const perQ = round5((r.gen + r.judge) / r.n);
    const perQGen = round5(r.gen / r.n);
    if (perQ > (rates[key] ?? 0)) rates[key] = perQ;
    if (perQGen > (rates_gen[key] ?? 0)) rates_gen[key] = perQGen;
  }
  return { rates, rates_gen };
}

export async function consolePayload(db: D1Database, tenant: string): Promise<ConsolePayload> {
  const { results } = await db.prepare(
    `SELECT json_extract(j.requested, '$.measured.model')      AS model,
            json_extract(j.requested, '$.measured.web_search') AS search,
            COUNT(*)                                           AS n,
            SUM(COALESCE(s.gen_cost, 0))                       AS gen,
            SUM(COALESCE(s.judge_cost, 0))                     AS judge
       FROM jobs j JOIN scores s ON s.job_id = j.id
      WHERE j.tenant = ? AND s.score IS NOT NULL
      GROUP BY j.id`
  ).bind(tenant).all<JobCostRow>();

  return {
    batch: BATCH,
    checks: Object.entries(CHECKS)
      .filter(([, c]) => c.ui)
      .map(([name, c]) => ({ name, field: c.field, label: c.label, desc: c.desc })),
    ...ratesFrom(results),
  };
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
