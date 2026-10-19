-- Atomic aligned 60-second domain-wide and subject-specific quota.
-- Both keys are fixed by the caller and share the domain hash tag. Store the
-- window in each hash so the script need not construct undeclared cluster keys.
local t = redis.call('TIME')
local seconds = tonumber(t[1])
local window = math.floor(seconds / 60)
local now_ms = seconds * 1000 + math.floor(tonumber(t[2]) / 1000)
local expires_ms = ((window + 1) * 60000) - now_ms + 1000

local global_window = tonumber(redis.call('HGET', KEYS[1], 'window'))
local global_count = tonumber(redis.call('HGET', KEYS[1], 'count')) or 0
if global_window ~= window then global_count = 0 end

local subject_window = tonumber(redis.call('HGET', KEYS[2], 'window'))
local subject_count = tonumber(redis.call('HGET', KEYS[2], 'count')) or 0
if subject_window ~= window then subject_count = 0 end

local global_limit = tonumber(ARGV[1])
local subject_limit = tonumber(ARGV[2])
if global_count >= global_limit or subject_count >= subject_limit then
  return 0
end

redis.call('HSET', KEYS[1], 'window', window, 'count', global_count + 1)
redis.call('PEXPIRE', KEYS[1], expires_ms)
redis.call('HSET', KEYS[2], 'window', window, 'count', subject_count + 1)
redis.call('PEXPIRE', KEYS[2], expires_ms)
return 1
