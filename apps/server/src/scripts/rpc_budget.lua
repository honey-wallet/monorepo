-- One operator-configured account budget across replicas/endpoints. Redis TIME is
-- authoritative. Granted units are never refunded, including cancellation.
-- KEYS: policy, next, cooldown. ARGV: policy fingerprint, spacing milliseconds.
local policy = redis.call('GET', KEYS[1])
if policy and policy ~= ARGV[1] then return {3, 0} end
if not policy then redis.call('SET', KEYS[1], ARGV[1]) end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cooldown = redis.call('GET', KEYS[3])
if cooldown == 'hold' then return {2, 0} end
if cooldown and not tonumber(cooldown) then return {3, 0} end
if tonumber(cooldown or '0') > now then return {2, 0} end
local next_at = redis.call('GET', KEYS[2])
if next_at and not tonumber(next_at) then return {3, 0} end
local wait = tonumber(next_at or '0') - now
if wait > 0 then return {0, wait} end
local spacing = tonumber(ARGV[2])
redis.call('SET', KEYS[2], now + spacing, 'PX', spacing + 1000)
return {1, 0}
