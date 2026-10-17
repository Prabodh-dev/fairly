local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

local bucket = math.floor(now / window_ms)
local bucket_start = bucket * window_ms
local elapsed = now - bucket_start
local cur_key = KEYS[1] .. ':' .. string.format('%.0f', bucket)
local prev_key = KEYS[1] .. ':' .. string.format('%.0f', bucket - 1)

local cur = tonumber(redis.call('GET', cur_key) or '0')
local prev = tonumber(redis.call('GET', prev_key) or '0')

local weighted_prev = math.floor(prev * (window_ms - elapsed) / window_ms)
local estimate = weighted_prev + cur

-- Smallest elapsed ms e in a window at which floor(p * (W - e) / W) <= t, given p > t >= 0.
local function first_elapsed_ms(p, t)
  return window_ms - math.floor(((t + 1) * window_ms - 1) / p)
end

if estimate >= limit then
  local reset_at
  local t = limit - 1 - cur
  if t >= 0 then
    reset_at = bucket_start + first_elapsed_ms(prev, t)
  else
    reset_at = bucket_start + window_ms + first_elapsed_ms(cur, limit - 1)
  end
  return { 0, 0, reset_at, reset_at - now }
end

cur = redis.call('INCR', cur_key)
if cur == 1 then
  redis.call('PEXPIRE', cur_key, 2 * window_ms - elapsed)
end
return { 1, limit - (weighted_prev + cur), bucket_start + window_ms, 0 }
