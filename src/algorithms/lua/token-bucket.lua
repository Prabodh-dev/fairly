local capacity = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

-- Balance is stored in units of 1/window_ms token so that refill (capacity units per ms) and
-- consumption (window_ms units per request) are exact integers.
local max_credit = capacity * window_ms
local credit = max_credit
local state = redis.call('HMGET', KEYS[1], 'credit', 'ts')
if state[1] then
  local elapsed = math.max(0, now - tonumber(state[2]))
  credit = math.min(max_credit, tonumber(state[1]) + elapsed * capacity)
end

local allowed = 0
local retry_after = 0
if credit >= window_ms then
  credit = credit - window_ms
  allowed = 1
else
  retry_after = math.ceil((window_ms - credit) / capacity)
end

local to_full = math.ceil((max_credit - credit) / capacity)
redis.call('HSET', KEYS[1], 'credit', string.format('%.0f', credit), 'ts', string.format('%.0f', now))
redis.call('PEXPIRE', KEYS[1], math.max(to_full, 1))

if allowed == 1 then
  return { 1, math.floor(credit / window_ms), now + to_full, 0 }
end
return { 0, 0, now + retry_after, retry_after }
