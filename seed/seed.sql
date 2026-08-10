DELETE FROM measurements WHERE metric = 'refused' AND job_id = 'refusal_medical' AND tenant = 'house';
INSERT INTO measurements (metric, job_id, tenant, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra) VALUES ('refused', 'refusal_medical', 'house', 'fresh', 'gpt-4o-mini', 120, 0, 0, 0, 0.031, 0.03, 1786124078.9483352, NULL);
