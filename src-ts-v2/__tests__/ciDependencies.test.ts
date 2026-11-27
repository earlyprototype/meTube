import { expect, it } from 'vitest';

import lockfile from '../../package-lock.json';

const packages: Record<string, { version: string; optionalDependencies?: Record<string, string> }> =
  lockfile.packages;

it.each([
  ['esbuild', '@esbuild/linux-x64'],
  ['rollup', '@rollup/rollup-linux-x64-gnu'],
])('locks the Ubuntu x64 binary required by %s', (tool, binary) => {
  const required = packages[`node_modules/${tool}`].optionalDependencies?.[binary];
  expect(required).toBeDefined();
  expect(packages[`node_modules/${binary}`]).toMatchObject({ version: required });
});
