local data = redis.call('HGET', KEYS[1], ARGV[1])
if not data or data == '' then return false end
-- Keep a write-once tombstone without extending the channel's original TTL.
redis.call('HSET', KEYS[1], ARGV[1], '')
return data
