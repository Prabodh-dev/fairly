local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

local bucket = math.floor(now / window_ms)
local reset_at = (bucket + 1) * window_ms
local bucket_key = KEYS[1] .. ':' .. string.format('%.0f', bucket)

local count = tonumber(redis.call('GET', bucket_key) or '0')
if count >= limit then
  return { 0, 0, reset_at, reset_at - now }
end

count = redis.call('INCR', bucket_key)
if count == 1 then
  redis.call('PEXPIRE', bucket_key, reset_at - now)
end
return { 1, limit - count, reset_at, 0 }
