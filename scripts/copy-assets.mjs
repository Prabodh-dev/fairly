import { cpSync } from 'node:fs';

const assets = ['algorithms/lua', 'policy/lua'];

for (const asset of assets) {
  cpSync(new URL(`../src/${asset}`, import.meta.url), new URL(`../dist/${asset}`, import.meta.url), { recursive: true });
}
