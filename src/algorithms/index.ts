import type { AlgorithmName } from '../config/types.js';
import { FixedWindow } from './fixed-window.js';
import { SlidingWindowCounter } from './sliding-window-counter.js';
import { SlidingWindowLog } from './sliding-window-log.js';
import { TokenBucket } from './token-bucket.js';
import type { Algorithm, AlgorithmDeps } from './types.js';

export function createAlgorithms(deps: AlgorithmDeps): Record<AlgorithmName, Algorithm> {
  return {
    'fixed-window': new FixedWindow(deps),
    'sliding-window-log': new SlidingWindowLog(deps),
    'sliding-window-counter': new SlidingWindowCounter(deps),
    'token-bucket': new TokenBucket(deps),
  };
}
