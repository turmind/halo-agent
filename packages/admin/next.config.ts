import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  output: 'export',
  // Repo and ~/ both carry lockfiles; pin the trace root to this monorepo so
  // Next.js stops inferring ~/package-lock.json as the workspace root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // Dev mode: proxy API requests to Hono server
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:9527/api/:path*',
      },
      {
        source: '/ws',
        destination: 'http://localhost:9527/ws',
      },
    ]
  },
}

export default nextConfig
