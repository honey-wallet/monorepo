local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = tonumber(redis.call('HGET', KEYS[1], 'next')) or 0
local lease = tonumber(redis.call('HGET', KEYS[1], 'lease')) or 0
if due > now or lease > now then return 0 end
redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'lease', now + 30000, 'next', now + 60000)
redis.call('PEXPIRE', KEYS[1], 120000)
return 1
