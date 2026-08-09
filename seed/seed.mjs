// Reads the curated (mode:"fresh") baselines out of fixtures/mirror.jsonl and
// emits seed.sql: idempotent INSERTs into the local D1 measurements table,
// tenant 'house'. Plain Node, no deps -- run with `node seed/seed.mjs` from the
// repo root, or `npm run seed:local` which also applies the file.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mirrorPath = join(here, '..', 'fixtures', 'mirror.jsonl');
const outPath = join(here, 'seed.sql');

const FIXED = new Set(['metric', 'job_id', 'mode', 'model_version', 'n', 'k', 'rate', 'ci_lo', 'ci_hi', 'cost', 'ts']);

// SQLite string literal escaping: wrap in '...', double up embedded quotes.
function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlNum(v) {
  return v === null || v === undefined ? 'NULL' : String(v);
}

const lines = readFileSync(mirrorPath, 'utf8').split('\n').filter(Boolean);
const records = lines.map(l => JSON.parse(l)).filter(r => r.mode === 'fresh');

if (!records.length) {
  throw new Error(`no mode:"fresh" records found in ${mirrorPath}`);
}

const statements = records.map(r => {
  const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !FIXED.has(k)));
  const extraJson = Object.keys(extra).length ? sqlStr(JSON.stringify(extra)) : 'NULL';

  const del = `DELETE FROM measurements WHERE metric = ${sqlStr(r.metric)} AND job_id = ${sqlStr(r.job_id)} AND tenant = 'house';`;
  const ins = `INSERT INTO measurements (metric, job_id, tenant, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra) VALUES (${sqlStr(r.metric)}, ${sqlStr(r.job_id)}, 'house', ${sqlStr(r.mode)}, ${sqlStr(r.model_version)}, ${sqlNum(r.n)}, ${sqlNum(r.k)}, ${sqlNum(r.rate)}, ${sqlNum(r.ci_lo)}, ${sqlNum(r.ci_hi)}, ${sqlNum(r.cost)}, ${sqlNum(r.ts)}, ${extraJson});`;
  return `${del}\n${ins}`;
});

writeFileSync(outPath, statements.join('\n') + '\n');
console.log(`wrote ${outPath} (${records.length} rows from ${mirrorPath})`);
