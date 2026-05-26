import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
