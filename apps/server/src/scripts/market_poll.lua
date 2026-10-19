-- One shared refresh lease and poll budget across API/ingestion replicas.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local owner = redis.call('HGET', KEYS[1], 'owner')
local lease = tonumber(redis.call('HGET', KEYS[1], 'leaseUntil')) or 0
if owner and owner ~= ARGV[1] and lease > now then return -1000 end
redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'leaseUntil', now + 10000)
local next_poll = tonumber(redis.call('HGET', KEYS[1], 'nextPoll')) or 0
if next_poll > now then return -(next_poll - now) end
redis.call('HSET', KEYS[1], 'nextPoll', now + 1000)
return now
