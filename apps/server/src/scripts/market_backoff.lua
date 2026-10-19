if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('HSET', KEYS[1], 'nextPoll', now + tonumber(ARGV[2]))
return 1
