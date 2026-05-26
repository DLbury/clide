import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isTauriBuild = process.env.TAURI_ENV_PLATFORM != null

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 仅监听 view 目录，避免扫描上级 src-tauri/target 等导致海量文件监听与 node 子进程泄漏
  turbopack: {
    root: __dirname,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  ...(isTauriBuild
    ? {
        output: 'export',
        distDir: 'out',
      }
    : {}),
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          '../src-tauri/**',
          '../**/target/**',
          '../node_modules/**',
        ],
      }
    }
    return config
  },
}

export default nextConfig
