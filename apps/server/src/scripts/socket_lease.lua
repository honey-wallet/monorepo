-- KEYS: global sockets and subject sockets. ARGV: mode, UUID, global cap, IP cap.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if ARGV[1] == 'release' then
  redis.call('ZREM', KEYS[1], ARGV[2]); redis.call('ZREM', KEYS[2], ARGV[2]); return 1
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if ARGV[1] == 'renew' then
  if not redis.call('ZSCORE', KEYS[1], ARGV[2]) or not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end
else
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 0 end
end
redis.call('ZADD', KEYS[1], now + 60000, ARGV[2])
redis.call('ZADD', KEYS[2], now + 60000, ARGV[2])
-- The global set is shared by all subjects. Expire it after one lease window so
-- closed sockets are reclaimed even when no later handshake arrives; live sockets
-- refresh this TTL on their regular lease renewal.
redis.call('PEXPIRE', KEYS[1], 60000)
redis.call('PEXPIRE', KEYS[2], 60000)
return 1
