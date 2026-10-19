-- KEYS: channel hash, global reservation ZSET, per-client reservation ZSET,
--       global reservation-size HASH, global payload-byte counter.
-- All keys share {pairing}. ARGV: slot, channel:slot member, encrypted/public data.
local SLOT_LIMITS = { commit = 43, nonce = 22, reveal = 64, payload = 16384 }
local MAX_SLOT_BYTES = 16384
local MAX_GLOBAL_BYTES = 33554432 -- 32 MiB of reserved slot payload bytes.
local MAX_GLOBAL_SLOTS = 10000
local MAX_CLIENT_SLOTS = 24
local TTL_MS = 300000

local data_len = string.len(ARGV[3])
local slot_limit = SLOT_LIMITS[ARGV[1]]
if not slot_limit or data_len == 0 or data_len > slot_limit then return 4 end

local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

-- During rollout, old reservation ZSETs have no byte metadata. Treat every live
-- legacy slot as the largest allowed slot before pruning, so unknown historical
-- payload sizes can only temporarily over-reserve capacity, never undercount it.
if not redis.call('GET', KEYS[5]) then
  local old_members = redis.call('ZRANGE', KEYS[2], 0, -1)
  local conservative_bytes = 0
  for _, member in ipairs(old_members) do
    redis.call('HSET', KEYS[4], member, MAX_SLOT_BYTES)
    conservative_bytes = conservative_bytes + MAX_SLOT_BYTES
  end
  redis.call('SET', KEYS[5], conservative_bytes)
  redis.call('PEXPIRE', KEYS[4], TTL_MS)
  redis.call('PEXPIRE', KEYS[5], TTL_MS)
  redis.call('PEXPIRE', KEYS[2], TTL_MS)
end

-- Retire expired reservations and their byte accounting together. Missing size
-- metadata is treated as the maximum payload size, which is fail-closed.
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms)
local released_bytes = 0
for _, member in ipairs(expired) do
  local size = tonumber(redis.call('HGET', KEYS[4], member)) or MAX_SLOT_BYTES
  released_bytes = released_bytes + size
  redis.call('HDEL', KEYS[4], member)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now_ms)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
if released_bytes > 0 then
  local current_bytes = tonumber(redis.call('GET', KEYS[5])) or 0
  redis.call('SET', KEYS[5], math.max(0, current_bytes - released_bytes))
  -- SET clears TTL; all remaining reservations were created within the last TTL.
  redis.call('PEXPIRE', KEYS[4], TTL_MS)
  redis.call('PEXPIRE', KEYS[5], TTL_MS)
  redis.call('PEXPIRE', KEYS[2], TTL_MS)
end

if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 1 end
if redis.call('ZCARD', KEYS[3]) >= MAX_CLIENT_SLOTS then return 2 end
if redis.call('ZCARD', KEYS[2]) >= MAX_GLOBAL_SLOTS then return 3 end
local current_bytes = tonumber(redis.call('GET', KEYS[5])) or 0
if current_bytes + data_len > MAX_GLOBAL_BYTES then return 3 end

local expires = tonumber(redis.call('HGET', KEYS[1], '_expires')) or (now_ms + TTL_MS)
-- Reserve count and bytes before allocating payload memory. Redis script errors do
-- not roll back prior writes; a partial reservation can deny capacity temporarily,
-- but cannot store uncounted payload bytes.
redis.call('ZADD', KEYS[2], expires, ARGV[2])
redis.call('ZADD', KEYS[3], expires, ARGV[2])
redis.call('HSET', KEYS[4], ARGV[2], data_len)
redis.call('INCRBY', KEYS[5], data_len)
redis.call('PEXPIRE', KEYS[3], TTL_MS)
redis.call('PEXPIRE', KEYS[2], TTL_MS)
redis.call('PEXPIRE', KEYS[4], TTL_MS)
redis.call('PEXPIRE', KEYS[5], TTL_MS)
redis.call('HSET', KEYS[1], '_expires', expires, ARGV[1], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], expires)
return 0
