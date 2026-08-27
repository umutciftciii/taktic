import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  // @taktic/shared ships TypeScript source rather than a build output, so Next
  // has to compile it like first-party code. Without this the shared urgency
  // table would only resolve by accident of hoisting.
  transpilePackages: ['@taktic/shared'],
};

export default nextConfig;
