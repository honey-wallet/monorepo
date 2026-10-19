local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] or (tonumber(redis.call('HGET', KEYS[1], 'lease')) or 0) <= now then return 0 end
if string.len(ARGV[2]) > 16384 then return 0 end
-- Preserve the validated JSON verbatim: Redis cjson re-encodes empty arrays as objects.
local data = '{\"publishedAtMs\":' .. tostring(now) .. ',\"observation\":' .. ARGV[2] .. '}'
redis.call('SET', KEYS[2], data, 'PX', 600000)
redis.call('HSET', KEYS[1], 'lease', 0)
return 1
