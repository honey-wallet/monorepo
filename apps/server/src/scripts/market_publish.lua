local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
if (tonumber(redis.call('HGET', KEYS[1], 'leaseUntil')) or 0) <= now then return 0 end
local epoch = redis.call('HGET', KEYS[1], 'epoch') or ARGV[2]
redis.call('HSET', KEYS[1], 'epoch', epoch)
redis.call('HINCRBY', KEYS[1], 'sequence', 1)
local sequence = redis.call('HGET', KEYS[1], 'sequence')
local frame = {schemaVersion=1, type='snapshot', epoch=epoch, sequence=sequence,
  sampledAtMs=now, stale=false, source='hyperliquid', prices=cjson.decode(ARGV[3])}
redis.call('SET', KEYS[2], cjson.encode(frame), 'PX', 60000)
return 1
