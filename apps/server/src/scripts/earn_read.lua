local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call('STRLEN', KEYS[1]) > 16384 then return {now, ''} end
return {now, redis.call('GET', KEYS[1]) or ''}
