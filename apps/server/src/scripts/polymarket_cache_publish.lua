-- KEYS: refresh lock and cache key (same {polymarket} Redis Cluster slot).
-- ARGV: owner token, serialized bounded cache entry, TTL in seconds.
-- A stale refresh owner must never overwrite a newer replica's observation.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
