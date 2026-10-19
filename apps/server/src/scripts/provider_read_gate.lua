-- All reader instances sharing a namespace share provider spacing and cooldown.
-- KEYS are one fixed provider hash slot. No client-selected provider or domain.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local raw_cooldown = redis.call('GET', KEYS[2])
if raw_cooldown == 'hold' then return {2, 0} end
local cooldown = tonumber(raw_cooldown) or 0
if cooldown > now then return {2, cooldown - now} end
local next_at = tonumber(redis.call('GET', KEYS[1])) or 0
if next_at > now then return {0, next_at - now} end
redis.call('SET', KEYS[1], now + 1000, 'PX', 2000)
return {1, 0}
