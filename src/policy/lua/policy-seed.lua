if redis.call('SET', KEYS[2], '1', 'NX') == false then
  return 0
end
for i = 1, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
return 1
