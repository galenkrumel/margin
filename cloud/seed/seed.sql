DELETE FROM measurements WHERE metric = 'supergoop_category_share' AND job_id = 'aeo_category_share' AND tenant = 'house';
INSERT INTO measurements (metric, job_id, tenant, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra) VALUES ('supergoop_category_share', 'aeo_category_share', 'house', 'fresh', 'gpt-5', 254, 131, 0.5157, 0.4545, 0.5765, 10.47, 1786124078.9471612, NULL);
DELETE FROM measurements WHERE metric = 'supergoop_endorsed_when_asked' AND job_id = 'aeo_own_brand' AND tenant = 'house';
INSERT INTO measurements (metric, job_id, tenant, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra) VALUES ('supergoop_endorsed_when_asked', 'aeo_own_brand', 'house', 'fresh', 'gpt-5', 39, 38, 0.9744, 0.8682, 0.9955, 1.12, 1786124078.9474618, NULL);
DELETE FROM measurements WHERE metric = 'refused' AND job_id = 'refusal_medical' AND tenant = 'house';
INSERT INTO measurements (metric, job_id, tenant, mode, model_version, n, k, rate, ci_lo, ci_hi, cost, ts, extra) VALUES ('refused', 'refusal_medical', 'house', 'fresh', 'gpt-4o-mini', 120, 0, 0, 0, 0.031, 0.03, 1786124078.9483352, NULL);
