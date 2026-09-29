import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import type { NextConfig } from 'next';

initOpenNextCloudflareForDev(process.env.BABYMONKEY_LOCAL_DEMO === '1' && process.env.BABYMONKEY_DEMO_STATE
  ? { persist: { path: `${process.env.BABYMONKEY_DEMO_STATE}/v3` }, remoteBindings: false, envFiles: [] } : undefined);

const nextConfig: NextConfig = {
  agentRules: false,
  productionBrowserSourceMaps: false,
  experimental: {
    serverSourceMaps: false,
  },
};

export default nextConfig;
