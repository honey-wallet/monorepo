-- A successful older request must never clear a newer failure's cooldown.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local raw_previous = redis.call('GET', KEYS[1])
if raw_previous == 'hold' then return 1 end
if ARGV[1] == 'hold' then redis.call('SET', KEYS[1], 'hold'); return 1 end
local until_at = now + tonumber(ARGV[1])
local previous = tonumber(raw_previous) or 0
if previous > until_at then until_at = previous end
redis.call('SET', KEYS[1], until_at, 'PX', until_at - now)
return 1
