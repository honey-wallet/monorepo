-- Atomic aligned 60-second subject quota. Redis-time TTL bounds key lifetime.
local t = redis.call('TIME')
local seconds = tonumber(t[1])
local window = math.floor(seconds / 60)
local now_ms = seconds * 1000 + math.floor(tonumber(t[2]) / 1000)
local expires_ms = ((window + 1) * 60000) - now_ms + 1000

local current_window = tonumber(redis.call('HGET', KEYS[1], 'window'))
local count = tonumber(redis.call('HGET', KEYS[1], 'count')) or 0
if current_window ~= window then count = 0 end

local limit = tonumber(ARGV[1])
if count >= limit then return 0 end

redis.call('HSET', KEYS[1], 'window', window, 'count', count + 1)
redis.call('PEXPIRE', KEYS[1], expires_ms)
return 1
