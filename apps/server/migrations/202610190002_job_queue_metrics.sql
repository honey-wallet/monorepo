-- Keep dead-letter count and oldest-age probes bounded by an ordered partial index.
-- Run concurrently so installing observability does not block durable queue writes.
-- If interrupted, inspect pg_index.indisvalid before retrying; do not mask an invalid
-- index with IF NOT EXISTS.
CREATE INDEX CONCURRENTLY jobs_dead_created ON jobs(created_at, id) WHERE state = 'dead';
