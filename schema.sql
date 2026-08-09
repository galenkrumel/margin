-- Margin cloud schema (D1 / SQLite). Four tables, no ORM.
--
-- jobs.result holds the full STATE-shaped JSON blob (see JobState in db.ts) --
-- same "just serialize the whole thing" move api.py made with its in-memory
-- STATE dict, just durable now. jobs.status is duplicated out of that blob
-- into its own column purely so it's indexable/filterable without a json_extract.
--
-- responses/scores are one row per prompt so a workflow step retry can ask
-- "what have I already done" with a plain SELECT instead of parsing a blob.

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  status     TEXT NOT NULL,          -- queued | running | done | error -- api.py STATE["status"]
  requested  TEXT NOT NULL,          -- JSON: the JobRequest as submitted (api.py:73-79), openai_key stripped
  result     TEXT NOT NULL,          -- JSON: the full STATE blob (api.py:286-322)
  created_at INTEGER NOT NULL,       -- epoch ms
  updated_at INTEGER NOT NULL        -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_created ON jobs (tenant, created_at);

CREATE TABLE IF NOT EXISTS responses (
  job_id      TEXT,
  qid         TEXT,
  ok          INTEGER,               -- 0/1 -- did the generate() call produce usable text
  text        TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  searches    INTEGER,
  cost        REAL,
  error       TEXT,
  PRIMARY KEY (job_id, qid)
);

CREATE TABLE IF NOT EXISTS scores (
  job_id      TEXT,
  qid         TEXT,
  flag        INTEGER,               -- 0/1 -- score[metric.aggregate_field], coerced to bool
  gen_cost    REAL,
  judge_cost  REAL,
  score       TEXT,                  -- JSON dict, or NULL when scoring failed (score_error set instead)
  score_error TEXT,
  PRIMARY KEY (job_id, qid)
);

CREATE TABLE IF NOT EXISTS measurements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  metric        TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  mode          TEXT NOT NULL,       -- 'live' (launched from the console) | 'fresh' (curated/seeded)
  model_version TEXT,
  n             INTEGER,
  k             INTEGER,
  rate          REAL,
  ci_lo         REAL,
  ci_hi         REAL,
  cost          REAL,
  ts            REAL NOT NULL,       -- epoch seconds, matches memory/mirror.jsonl's "ts"
  extra         TEXT                 -- JSON: optional mirror-line fields (interval, prior_n_eff, baseline_n, baseline_rate, drift)
);
CREATE INDEX IF NOT EXISTS idx_measurements_metric_tenant_ts ON measurements (metric, tenant, ts);
