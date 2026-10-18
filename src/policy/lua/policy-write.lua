local mode = ARGV[1]
local exists = redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1
if mode == 'create' and exists then
  return 0
end
if mode == 'update' and not exists then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
return 1
